from __future__ import annotations

import argparse
import base64
import csv
import hashlib
import hmac
import io
import json
import os
import posixpath
import secrets
import socketserver
import sys
import time
import urllib.parse
import threading
from functools import partial
from http import HTTPStatus
from http.cookies import SimpleCookie
from http.server import SimpleHTTPRequestHandler
from pathlib import Path
from xml.sax.saxutils import escape
import re

from .sql_backend import COMPONENT_COLUMNS, TABLE, delete_record, find_by_pan, get_connection, list_records, load_protected_settings, save_record


SESSIONS: dict[str, float] = {}
LOGIN_ATTEMPTS: dict[str, list[float]] = {}
SESSION_SECONDS = 8 * 60 * 60
MAX_LOGIN_ATTEMPTS = 8


def password_hash(password: str, *, salt: bytes | None = None, iterations: int = 260_000) -> dict[str, object]:
    salt = salt or secrets.token_bytes(16)
    digest = hashlib.pbkdf2_hmac("sha256", password.encode("utf-8"), salt, iterations)
    return {
        "salt": base64.b64encode(salt).decode("ascii"),
        "hash": base64.b64encode(digest).decode("ascii"),
        "iterations": iterations,
    }


def verify_password(password: str, stored: dict[str, object]) -> bool:
    try:
        salt = base64.b64decode(str(stored["salt"]), validate=True)
        expected = base64.b64decode(str(stored["hash"]), validate=True)
        iterations = int(stored.get("iterations", 260_000))
    except (KeyError, TypeError, ValueError):
        return False
    actual = hashlib.pbkdf2_hmac("sha256", password.encode("utf-8"), salt, iterations)
    return hmac.compare_digest(actual, expected)


class EncorpRequestHandler(SimpleHTTPRequestHandler):
    server_version = "Encorp/1.1"

    def __init__(self, *args, directory=None, **kwargs):
        project_root = Path(__file__).resolve().parents[1]
        self.search_roots = [Path(directory).resolve()] if directory else []
        self.search_roots.append(project_root / "encorp_app" / "static")
        self.search_roots = [path.resolve() for path in self.search_roots if path.exists()]
        super().__init__(*args, directory=str(self.search_roots[0]), **kwargs)

    @staticmethod
    def _route(path: str) -> str:
        route = urllib.parse.urlparse(path).path
        if route == "/encorp":
            return "/"
        if route.startswith("/encorp/"):
            return route[len("/encorp"):]
        return route

    def translate_path(self, path):
        path = self._route(path).split("?", 1)[0].split("#", 1)[0]
        path = posixpath.normpath(urllib.parse.unquote(path)).lstrip("/")
        if path in {"", "."}:
            path = "index.html"
        for root in self.search_roots:
            candidate = (root / path).resolve()
            try:
                candidate.relative_to(root)
            except ValueError:
                continue
            if candidate.is_file():
                return str(candidate)
        return str((self.search_roots[0] / "__not_found__").resolve())

    def end_headers(self) -> None:
        self.send_header("X-Content-Type-Options", "nosniff")
        self.send_header("X-Frame-Options", "DENY")
        self.send_header("Referrer-Policy", "same-origin")
        self.send_header("Content-Security-Policy", "default-src 'self'; img-src 'self' data:; style-src 'self' 'unsafe-inline'; script-src 'self'; connect-src 'self'; font-src 'self' data:")
        self.send_header("Cache-Control", "no-store" if self._route(self.path).startswith("/api/") else "no-cache")
        super().end_headers()

    def guess_type(self, path):
        content_type = super().guess_type(path)
        if content_type.startswith(("text/", "application/javascript", "application/json", "image/svg+xml")):
            return f"{content_type.split(';', 1)[0]}; charset=utf-8"
        return content_type

    def do_GET(self) -> None:  # noqa: N802
        route = self._route(self.path)
        if route in {"", "/"}:
            self.path = "/index.html"
            super().do_GET()
        elif route == "/api/session":
            self.send_json({"authenticated": self.is_authenticated()})
        elif route == "/api/health":
            self.handle_health()
        elif route == "/api/db_check":
            self.require_auth(self.handle_db_check_v2)
        elif route == "/api/db_schema_check":
            self.require_auth(self.handle_schema_check)
        elif route.startswith("/api/records"):
            self.require_auth(self.handle_records_api)
        else:
            super().do_GET()

    def do_POST(self) -> None:  # noqa: N802
        route = self._route(self.path)
        if route == "/api/login":
            self.handle_login()
        elif route == "/api/logout":
            self.handle_logout()
        elif route == "/api/pdf":
            self.require_auth(self.handle_pdf_api, mutation=True)
        elif route == "/api/records":
            self.require_auth(self.handle_records_api, mutation=True)
        else:
            self.send_error(HTTPStatus.NOT_FOUND)

    def do_DELETE(self) -> None:  # noqa: N802
        if self._route(self.path) == "/api/records":
            self.require_auth(self.handle_records_api, mutation=True)
        else:
            self.send_error(HTTPStatus.NOT_FOUND)

    def read_json(self, *, limit: int = 1_000_000) -> dict:
        length = int(self.headers.get("Content-Length", "0"))
        if length > limit:
            raise ValueError("The request is too large.")
        payload = json.loads(self.rfile.read(length).decode("utf-8") if length else "{}")
        if not isinstance(payload, dict):
            raise ValueError("Invalid request.")
        return payload

    def _session_token(self) -> str | None:
        cookie = SimpleCookie(self.headers.get("Cookie", ""))
        morsel = cookie.get("encorp_session")
        return morsel.value if morsel else None

    def is_authenticated(self) -> bool:
        now = time.time()
        token = self._session_token()
        for key, expires in list(SESSIONS.items()):
            if expires <= now:
                SESSIONS.pop(key, None)
        return bool(token and SESSIONS.get(token, 0) > now)

    def require_auth(self, action, *, mutation: bool = False) -> None:
        if not self.is_authenticated():
            self.send_json({"error": "Please sign in again."}, HTTPStatus.UNAUTHORIZED)
            return
        if mutation:
            origin = self.headers.get("Origin")
            host = self.headers.get("Host", "")
            if origin and urllib.parse.urlparse(origin).netloc != host:
                self.send_json({"error": "Request origin was rejected."}, HTTPStatus.FORBIDDEN)
                return
        action()

    def handle_login(self) -> None:
        ip = self.client_address[0]
        now = time.time()
        attempts = [stamp for stamp in LOGIN_ATTEMPTS.get(ip, []) if stamp > now - 900]
        if len(attempts) >= MAX_LOGIN_ATTEMPTS:
            self.send_json({"error": "Too many sign-in attempts. Please wait 15 minutes."}, HTTPStatus.TOO_MANY_REQUESTS)
            return
        try:
            payload = self.read_json(limit=16_384)
            username = str(payload.get("username", "")).strip().lower()
            password = str(payload.get("password", ""))
            users = load_protected_settings().get("auth_users", {})
            stored = users.get(username) if isinstance(users, dict) else None
            valid_file_login = isinstance(stored, dict) and verify_password(password, stored)
            render_username = os.getenv("ENCORP_ADMIN_USERNAME", "Encorp").strip().lower()
            render_password = os.getenv("ENCORP_ADMIN_PASSWORD", "encorp123")
            valid_render_login = bool(
                render_username
                and render_password
                and hmac.compare_digest(username, render_username)
                and hmac.compare_digest(password, render_password)
            )
            if not (valid_file_login or valid_render_login):
                attempts.append(now)
                LOGIN_ATTEMPTS[ip] = attempts
                self.send_json({"error": "The username or password is incorrect."}, HTTPStatus.UNAUTHORIZED)
                return
            LOGIN_ATTEMPTS.pop(ip, None)
            token = secrets.token_urlsafe(32)
            SESSIONS[token] = now + SESSION_SECONDS
            forwarded_proto = self.headers.get("X-Forwarded-Proto", "").split(",", 1)[0].strip().lower()
            secure = "; Secure" if forwarded_proto == "https" else ""
            self.send_json({"ok": True}, headers={"Set-Cookie": f"encorp_session={token}; HttpOnly; SameSite=Strict; Path=/; Max-Age={SESSION_SECONDS}{secure}"})
        except Exception:
            self.send_json({"error": "Sign-in is not configured correctly."}, HTTPStatus.INTERNAL_SERVER_ERROR)

    def handle_logout(self) -> None:
        token = self._session_token()
        if token:
            SESSIONS.pop(token, None)
        self.send_json({"ok": True}, headers={"Set-Cookie": "encorp_session=; HttpOnly; SameSite=Strict; Path=/; Max-Age=0"})

    def handle_health(self) -> None:
        payload = {"ok": True, "database": "not checked"}
        status = HTTPStatus.OK
        if self.is_authenticated():
            try:
                conn = get_connection()
                conn.close()
                payload["database"] = "connected"
            except Exception:
                payload["database"] = "unavailable"
                status = HTTPStatus.SERVICE_UNAVAILABLE
        self.send_json(payload, status)

    def handle_db_check_v2(self) -> None:
        """Diagnostic endpoint that attempts a DB connection and returns a sanitized result.

        This endpoint is protected by authentication to avoid exposing internal details.
        """
        try:
            conn = get_connection()
            try:
                cursor = conn.cursor()
                try:
                    cursor.execute("SELECT 1")
                finally:
                    try:
                        cursor.close()
                    except Exception:
                        pass
            finally:
                try:
                    conn.close()
                except Exception:
                    pass
            self.send_json({"ok": True, "database": "connected"})
        except Exception as exc:
            import re as _re
            msg = str(exc)
            # Redact common connection-string keys and their values to avoid leaking secrets
            msg = _re.sub(r'(?i)password=[^;]+;?', 'Password=[REDACTED];', msg)
            msg = _re.sub(r'(?i)data source=[^;]+;?', 'Data Source=[REDACTED];', msg)
            msg = _re.sub(r'(?i)server=[^;]+;?', 'Server=[REDACTED];', msg)
            msg = _re.sub(r'(?i)user id=[^;]+;?', 'User ID=[REDACTED];', msg)
            msg = _re.sub(r'(?i)initial catalog=[^;]+;?', 'Initial Catalog=[REDACTED];', msg)
            print(f"DB check error: {type(exc).__name__}: {msg}", file=sys.stderr, flush=True)
            self.send_json({"ok": False, "error": msg}, HTTPStatus.SERVICE_UNAVAILABLE)

    def handle_db_check(self) -> None:
        """Diagnostic endpoint that attempts a DB connection and returns a sanitized result.

        This endpoint is protected by authentication to avoid exposing internal details.
        """
        try:
            conn = get_connection()
            try:
                # Try a lightweight check: execute a simple statement if the provider supports it.
                cursor = conn.cursor()
                try:
                    cursor.execute("SELECT 1")
                finally:
                    try:
                        cursor.close()
                    except Exception:
                        pass
            finally:
                try:
                    conn.close()
                except Exception:
                    pass
            self.send_json({"ok": True, "database": "connected"})
        except Exception as exc:
            # Sanitize any sensitive fields that might appear in exception messages.
            msg = str(exc)
            # Redact common connection-string keys and their values.
            msg = re.sub(r'(?i)password=[^;]+;?', 'Password=[REDACTED];', msg)
            msg = re.sub(r'(?i)data source=[^;]+;?', 'Data Source=[REDACTED];', msg)
            msg = re.sub(r'(?i)server=[^;]+;?', 'Server=[REDACTED];', msg)
            msg = re.sub(r'(?i)user id=[^;]+;?', 'User ID=[REDACTED];', msg)
            msg = re.sub(r'(?i)initial catalog=[^;]+;?', 'Initial Catalog=[REDACTED];', msg)
            print(f"DB check error: {type(exc).__name__}: {msg}", file=sys.stderr, flush=True)
            self.send_json({"ok": False, "error": msg}, HTTPStatus.SERVICE_UNAVAILABLE)

    def handle_schema_check(self) -> None:
        """Check that the Salary_Structure table exists and return its top-level columns."""
        try:
            conn = get_connection()
            try:
                cursor = conn.cursor()
                try:
                    cursor.execute(f"SELECT TOP 1 * FROM {TABLE}")
                    columns = [col[0] for col in (cursor.description or [])]
                finally:
                    try:
                        cursor.close()
                    except Exception:
                        pass
            finally:
                try:
                    conn.close()
                except Exception:
                    pass
            expected = {"PAN", "EmployeeName", "ComponentValues"}
            has_expected = bool(columns and expected.intersection(set(columns)))
            self.send_json({"ok": True, "table": "found", "columns": columns, "has_expected_columns": has_expected})
        except Exception as exc:
            import re as _re
            msg = str(exc)
            msg = _re.sub(r'(?i)password=[^;]+;?', 'Password=[REDACTED];', msg)
            msg = _re.sub(r'(?i)data source=[^;]+;?', 'Data Source=[REDACTED];', msg)
            msg = _re.sub(r'(?i)server=[^;]+;?', 'Server=[REDACTED];', msg)
            msg = _re.sub(r'(?i)user id=[^;]+;?', 'User ID=[REDACTED];', msg)
            msg = _re.sub(r'(?i)initial catalog=[^;]+;?', 'Initial Catalog=[REDACTED];', msg)
            print(f"Schema check error: {type(exc).__name__}: {msg}", file=sys.stderr, flush=True)
            self.send_json({"ok": False, "error": msg}, HTTPStatus.SERVICE_UNAVAILABLE)

    def handle_records_api(self) -> None:
        parsed = urllib.parse.urlparse(self._route(self.path) + ("?" + urllib.parse.urlparse(self.path).query if urllib.parse.urlparse(self.path).query else ""))
        params = urllib.parse.parse_qs(parsed.query)
        try:
            if parsed.path == "/api/records" and self.command == "GET":
                pan = params.get("pan", [""])[0]
                conn = get_connection()
                try:
                    payload = find_by_pan(conn, pan) if pan else list_records(conn)
                finally:
                    conn.close()
                if pan and payload is None:
                    self.send_json({"error": "No salary record exists for this PAN."}, HTTPStatus.NOT_FOUND)
                else:
                    self.send_json(payload if payload is not None else {})
                return
            if parsed.path == "/api/records" and self.command == "POST":
                record = self.read_json()
                conn = get_connection()
                try:
                    saved = save_record(conn, record, update=str(record.get("mode", "create")).lower() == "update")
                finally:
                    conn.close()
                self.send_json({"ok": True, "record": saved})
                return
            if parsed.path == "/api/records" and self.command == "DELETE":
                pan = params.get("pan", [""])[0]
                if not pan:
                    raise ValueError("A PAN number is required.")
                conn = get_connection()
                try:
                    deleted = delete_record(conn, pan)
                finally:
                    conn.close()
                if not deleted:
                    self.send_json({"error": "No salary record exists for this PAN."}, HTTPStatus.NOT_FOUND)
                else:
                    self.send_json({"ok": True, "pan": pan.upper()})
                return
            if parsed.path == "/api/records/export" and self.command == "GET":
                conn = get_connection()
                try:
                    records = list_records(conn)
                finally:
                    conn.close()
                is_excel = params.get("format", ["csv"])[0].lower() == "excel"
                content = self.build_excel_content(records) if is_excel else self.build_csv_content(records)
                self.send_bytes(content.encode("utf-8-sig"), "application/vnd.ms-excel" if is_excel else "text/csv", "encorp-salary-records.xls" if is_excel else "encorp-salary-records.csv")
                return
            self.send_error(HTTPStatus.NOT_FOUND)
        except (ValueError, LookupError) as exc:
            self.send_json({"error": str(exc)}, HTTPStatus.BAD_REQUEST)
        except Exception as exc:
            print(f"Records API error: {type(exc).__name__}", file=sys.stderr, flush=True)
            self.send_json({"error": "The salary database is currently unavailable."}, HTTPStatus.SERVICE_UNAVAILABLE)

    def handle_pdf_api(self) -> None:
        try:
            payload = self.read_json(limit=2_000_000)
            pdf = self.build_salary_pdf(payload)
            pan = "".join(char for char in str(payload.get("pan", "salary-structure")) if char.isalnum() or char in "_-")
            self.send_bytes(pdf, "application/pdf", f"Salary_Structure_{pan or 'salary-structure'}.pdf")
        except ValueError as exc:
            self.send_json({"error": str(exc)}, HTTPStatus.BAD_REQUEST)
        except Exception:
            self.send_json({"error": "The salary PDF could not be created."}, HTTPStatus.INTERNAL_SERVER_ERROR)

    def build_salary_pdf(self, payload: dict) -> bytes:
        try:
            from reportlab.lib import colors
            from reportlab.lib.enums import TA_CENTER, TA_RIGHT
            from reportlab.lib.pagesizes import A4
            from reportlab.lib.styles import ParagraphStyle, getSampleStyleSheet
            from reportlab.lib.units import mm
            from reportlab.lib.utils import ImageReader
            from reportlab.platypus import Image as PdfImage
            from reportlab.platypus import KeepTogether, Paragraph, SimpleDocTemplate, Spacer, Table, TableStyle
        except ImportError as exc:
            raise RuntimeError("PDF support is not installed.") from exc

        values = payload.get("values", [])
        if isinstance(values, str):
            try:
                values = json.loads(values)
            except json.JSONDecodeError:
                values = []
        if not isinstance(values, list):
            raise ValueError("Salary values are invalid.")

        def safe(value: object, fallback: str = "-") -> str:
            text = str(value or "").strip()
            return text or fallback

        def amount(value: object) -> float:
            try:
                return float(value or 0)
            except (TypeError, ValueError):
                return 0.0

        def money(value: float) -> str:
            return f"Rs. {value:,.2f}"

        rows = []
        totals = {"earning": 0.0, "deduction": 0.0, "benefit": 0.0}
        for item in values:
            if not isinstance(item, dict):
                continue
            category = str(item.get("type", "earning")).lower()
            if category not in totals:
                category = "benefit"
            monthly = amount(item.get("monthly"))
            totals[category] += monthly
            if monthly:
                rows.append([safe(item.get("name", item.get("id", "Component"))), category.title(), money(monthly), money(monthly * 12)])

        buffer = io.BytesIO()
        document = SimpleDocTemplate(buffer, pagesize=A4, rightMargin=10 * mm, leftMargin=10 * mm, topMargin=8 * mm, bottomMargin=12 * mm, title="Salary Structure")
        styles = getSampleStyleSheet()
        styles.add(ParagraphStyle(name="BrandTitle", parent=styles["Title"], fontName="Helvetica-Bold", fontSize=15, leading=17, alignment=TA_CENTER, textColor=colors.HexColor("#0F5D8F"), spaceAfter=1))
        styles.add(ParagraphStyle(name="Subtle", parent=styles["Normal"], fontSize=7, leading=8.5, textColor=colors.HexColor("#536778")))
        styles.add(ParagraphStyle(name="Section", parent=styles["Heading2"], fontName="Helvetica-Bold", fontSize=9, leading=10, textColor=colors.HexColor("#0F5D8F"), spaceBefore=3, spaceAfter=2))
        styles.add(ParagraphStyle(name="RightSmall", parent=styles["Subtle"], alignment=TA_RIGHT))
        styles.add(ParagraphStyle(name="CenterSmall", parent=styles["Subtle"], alignment=TA_CENTER))

        company = safe(payload.get("company_name"), "Encorp Powertrans Pvt. Ltd.")
        header_items = []
        logo_data = str(payload.get("logo_data") or "")
        if logo_data.startswith("data:image/") and ";base64," in logo_data:
            try:
                encoded = logo_data.split(",", 1)[1]
                logo_bytes = base64.b64decode(encoded, validate=True)
                if len(logo_bytes) <= 1_500_000:
                    reader = ImageReader(io.BytesIO(logo_bytes))
                    width, height = reader.getSize()
                    scale = min((18 * mm) / width, (14 * mm) / height)
                    logo = PdfImage(io.BytesIO(logo_bytes), width=width * scale, height=height * scale)
                    logo.hAlign = "CENTER"
                    header_items.extend([logo, Spacer(1, 1 * mm)])
            except Exception:
                pass
        header_items.extend([
            Paragraph(escape(company), styles["BrandTitle"]),
            Paragraph(escape(safe(payload.get("company_tagline"), "Employee Salary Portal")), styles["CenterSmall"]),
            Paragraph("SALARY STRUCTURE OFFER", styles["CenterSmall"]),
        ])
        header_table = Table([[header_items]], colWidths=[190 * mm])
        header_table.setStyle(TableStyle([("ALIGN", (0, 0), (-1, -1), "CENTER"), ("VALIGN", (0, 0), (-1, -1), "MIDDLE"), ("BOTTOMPADDING", (0, 0), (-1, -1), 2)]))
        story = [header_table, Spacer(1, 2 * mm)]
        details = [
            ["Employee Name", safe(payload.get("employee_name")), "PAN Number", safe(payload.get("pan"))],
            ["Department", safe(payload.get("department")), "Designation", safe(payload.get("designation"))],
            ["Date of Joining", safe(payload.get("doj")), "Offer Date", safe(payload.get("offer_date"))],
        ]
        detail_table = Table(details, colWidths=[30 * mm, 65 * mm, 30 * mm, 65 * mm], rowHeights=7 * mm)
        detail_table.setStyle(TableStyle([
            ("BACKGROUND", (0, 0), (0, -1), colors.HexColor("#EAF3F7")), ("BACKGROUND", (2, 0), (2, -1), colors.HexColor("#EAF3F7")),
            ("FONTNAME", (0, 0), (-1, -1), "Helvetica"), ("FONTNAME", (0, 0), (0, -1), "Helvetica-Bold"), ("FONTNAME", (2, 0), (2, -1), "Helvetica-Bold"),
            ("FONTSIZE", (0, 0), (-1, -1), 7), ("TEXTCOLOR", (0, 0), (-1, -1), colors.HexColor("#172B3A")),
            ("GRID", (0, 0), (-1, -1), 0.35, colors.HexColor("#C8D8E1")), ("VALIGN", (0, 0), (-1, -1), "MIDDLE"), ("LEFTPADDING", (0, 0), (-1, -1), 5),
        ]))
        story.extend([detail_table, Paragraph("Compensation Breakdown", styles["Section"])])

        table_data = [["Component", "Category", "Monthly", "Annual"]] + rows
        salary_table = Table(table_data, colWidths=[80 * mm, 35 * mm, 37 * mm, 38 * mm], rowHeights=4.6 * mm, repeatRows=1)
        salary_table.setStyle(TableStyle([
            ("BACKGROUND", (0, 0), (-1, 0), colors.HexColor("#0F5D8F")), ("TEXTCOLOR", (0, 0), (-1, 0), colors.white),
            ("FONTNAME", (0, 0), (-1, 0), "Helvetica-Bold"), ("FONTNAME", (0, 1), (-1, -1), "Helvetica"),
            ("FONTSIZE", (0, 0), (-1, -1), 6.5), ("ALIGN", (2, 1), (-1, -1), "RIGHT"),
            ("ROWBACKGROUNDS", (0, 1), (-1, -1), [colors.white, colors.HexColor("#F5F8FA")]),
            ("GRID", (0, 0), (-1, -1), 0.3, colors.HexColor("#CDD9DF")), ("TOPPADDING", (0, 0), (-1, -1), 1.5), ("BOTTOMPADDING", (0, 0), (-1, -1), 1.5),
        ]))
        story.append(salary_table)

        gross = totals["earning"]
        deductions = totals["deduction"]
        benefits = totals["benefit"]
        summary = [
            ["Gross Earnings", money(gross), money(gross * 12)],
            ["Total Deductions", money(deductions), money(deductions * 12)],
            ["Cash in Hand", money(gross - deductions), money((gross - deductions) * 12)],
            ["Benefits", money(benefits), money(benefits * 12)],
            ["Total CTC", money(gross + benefits), money((gross + benefits) * 12)],
        ]
        summary_table = Table([["Summary", "Monthly", "Annual"], *summary], colWidths=[90 * mm, 50 * mm, 50 * mm], rowHeights=4.8 * mm)
        summary_table.setStyle(TableStyle([
            ("BACKGROUND", (0, 0), (-1, 0), colors.HexColor("#EAF3F7")), ("FONTNAME", (0, 0), (-1, 0), "Helvetica-Bold"),
            ("FONTNAME", (0, 1), (0, -1), "Helvetica-Bold"), ("FONTNAME", (0, -1), (-1, -1), "Helvetica-Bold"),
            ("BACKGROUND", (0, -1), (-1, -1), colors.HexColor("#FFF3CD")), ("ALIGN", (1, 0), (-1, -1), "RIGHT"),
            ("FONTSIZE", (0, 0), (-1, -1), 6.5), ("GRID", (0, 0), (-1, -1), 0.35, colors.HexColor("#C8D8E1")),
            ("TOPPADDING", (0, 0), (-1, -1), 1.5), ("BOTTOMPADDING", (0, 0), (-1, -1), 1.5),
        ]))
        story.extend([Spacer(1, 1 * mm), KeepTogether([Paragraph("Salary Summary", styles["Section"]), summary_table])])
        terms = [
            "This salary structure is subject to final management and HR approval.",
            "Applicable taxes and statutory deductions will be applied according to company policy and law.",
            "Benefits and components may be revised in line with company policy.",
        ]
        story.extend([Paragraph("Terms and Conditions", styles["Section"]), *[Paragraph(f"- {escape(term)}", styles["Subtle"]) for term in terms], Spacer(1, 2 * mm)])
        signatures = Table([[Paragraph(f"For and on behalf of<br/><b>{escape(company)}</b>", styles["Subtle"]), Paragraph("Authorized Signatory<br/><b>HR and Payroll</b>", styles["RightSmall"])]], colWidths=[90 * mm, 90 * mm])
        story.append(signatures)

        def footer(canvas, doc):
            canvas.saveState()
            canvas.setStrokeColor(colors.HexColor("#D7E1E7"))
            canvas.line(10 * mm, 9 * mm, 200 * mm, 9 * mm)
            canvas.setFont("Helvetica", 7)
            canvas.setFillColor(colors.HexColor("#6D7C86"))
            canvas.drawString(10 * mm, 5 * mm, "Confidential salary document")
            canvas.drawRightString(200 * mm, 5 * mm, f"Page {doc.page}")
            canvas.restoreState()

        document.build(story, onFirstPage=footer, onLaterPages=footer)
        return buffer.getvalue()

    @staticmethod
    def _export_columns() -> list[str]:
        return ["PAN", "Employee Name", "Department", "Designation", "DOJ", *COMPONENT_COLUMNS.values(), "GrossSalaryPayable", "DeductionTotal", "CashInHand", "BenefitTotal", "TotalCTC"]

    @staticmethod
    def _safe_export(value: object) -> str:
        text = str(value if value is not None else "")
        return "'" + text if text[:1] in {"=", "+", "-", "@"} else text

    def _export_value(self, record: dict, column: str) -> str:
        mapping = {"PAN": "pan", "Employee Name": "employee_name", "Department": "department", "Designation": "designation", "DOJ": "doj"}
        return self._safe_export(record.get(mapping.get(column, column), ""))

    def build_csv_content(self, records: list[dict]) -> str:
        output = io.StringIO(newline="")
        writer = csv.writer(output)
        writer.writerow(self._export_columns())
        writer.writerows([[self._export_value(record, column) for column in self._export_columns()] for record in records])
        return output.getvalue()

    def build_excel_content(self, records: list[dict]) -> str:
        columns = self._export_columns()
        rows = ["<Row>" + "".join(f'<Cell><Data ss:Type="String">{escape(column)}</Data></Cell>' for column in columns) + "</Row>"]
        for record in records:
            rows.append("<Row>" + "".join(f'<Cell><Data ss:Type="String">{escape(self._export_value(record, column))}</Data></Cell>' for column in columns) + "</Row>")
        return '<?xml version="1.0"?><Workbook xmlns="urn:schemas-microsoft-com:office:spreadsheet" xmlns:ss="urn:schemas-microsoft-com:office:spreadsheet"><Worksheet ss:Name="Records"><Table>' + "".join(rows) + "</Table></Worksheet></Workbook>"

    def send_json(self, payload: object, status: HTTPStatus = HTTPStatus.OK, *, headers: dict[str, str] | None = None) -> None:
        body = json.dumps(payload, ensure_ascii=False).encode("utf-8")
        self.send_response(status)
        self.send_header("Content-Type", "application/json; charset=utf-8")
        self.send_header("Content-Length", str(len(body)))
        for name, value in (headers or {}).items():
            self.send_header(name, value)
        self.end_headers()
        self.wfile.write(body)

    def send_bytes(self, body: bytes, content_type: str, file_name: str) -> None:
        self.send_response(HTTPStatus.OK)
        self.send_header("Content-Type", content_type)
        self.send_header("Content-Disposition", f'attachment; filename="{file_name}"')
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)


class EncorpServer(socketserver.ThreadingTCPServer):
    allow_reuse_address = True
    daemon_threads = True


def main() -> None:
    parser = argparse.ArgumentParser(description="Run the Encorp salary portal")
    parser.add_argument("--host", default=os.getenv("HOST", "127.0.0.1"))
    parser.add_argument("--port", type=int, default=int(os.getenv("PORT", "3000")))
    parser.add_argument("--directory", default=None)
    args = parser.parse_args()
    static_dir = Path(args.directory).resolve() if args.directory else Path(__file__).resolve().parent / "static"
    handler = partial(EncorpRequestHandler, directory=str(static_dir))

    # Startup DB schema check — run once and write a sanitized result to the logs so Render shows DB status on deploy.
    def _sanitized_msg(exc):
        import re as _re
        msg = str(exc)
        msg = _re.sub(r'(?i)password=[^;]+;?', 'Password=[REDACTED];', msg)
        msg = _re.sub(r'(?i)data source=[^;]+;?', 'Data Source=[REDACTED];', msg)
        msg = _re.sub(r'(?i)server=[^;]+;?', 'Server=[REDACTED];', msg)
        msg = _re.sub(r'(?i)user id=[^;]+;?', 'User ID=[REDACTED];', msg)
        msg = _re.sub(r'(?i)initial catalog=[^;]+;?', 'Initial Catalog=[REDACTED];', msg)
        return msg

    try:
        conn = get_connection()
        try:
            cursor = conn.cursor()
            try:
                cursor.execute(f"SELECT TOP 1 * FROM {TABLE}")
                cols = [c[0] for c in (cursor.description or [])]
            finally:
                try:
                    cursor.close()
                except Exception:
                    pass
        finally:
            try:
                conn.close()
            except Exception:
                pass
        expected = {"PAN", "EmployeeName", "ComponentValues"}
        has_expected = bool(cols and expected.intersection(set(cols)))
        print(f"DB schema check: connected, table={TABLE}, columns={cols}, has_expected_columns={has_expected}", flush=True)
    except Exception as exc:
        print(f"DB schema check failed: {_sanitized_msg(exc)}", file=sys.stderr, flush=True)

    # Start a background monitor thread to keep checking DB availability periodically and log results.
    def _db_monitor_loop(interval_seconds: int = 60):
        while True:
            try:
                conn = get_connection()
                try:
                    cursor = conn.cursor()
                    try:
                        cursor.execute('SELECT 1')
                    finally:
                        try:
                            cursor.close()
                        except Exception:
                            pass
                finally:
                    try:
                        conn.close()
                    except Exception:
                        pass
                print(f"DB monitor: connected at {time.strftime('%Y-%m-%d %H:%M:%S')}", flush=True)
            except Exception as exc:
                print(f"DB monitor: failed: {_sanitized_msg(exc)}", file=sys.stderr, flush=True)
            try:
                time.sleep(interval_seconds)
            except Exception:
                break

    monitor = threading.Thread(target=_db_monitor_loop, args=(60,), daemon=True)
    monitor.start()

    with EncorpServer((args.host, args.port), handler) as httpd:
        print(f"Serving Encorp at http://{args.host}:{args.port}/index.html", flush=True)
        httpd.serve_forever()


if __name__ == "__main__":
    main()
