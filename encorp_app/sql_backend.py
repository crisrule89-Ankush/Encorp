"""Microsoft SQL Server storage for Encorp salary records.

Private connection details are read from environment variables or from a
settings.protected JSON file. They are never embedded in the application code.
"""

from __future__ import annotations

import datetime as dt
import json
import os
from pathlib import Path
from typing import Any


TABLE = "dbo.Salary_Structure"
COMPONENT_COLUMNS = {
    "basic": "BasicSalary", "hra": "HouseRentAllowance", "medical": "MedicalAllowances",
    "conveyance": "ConveyanceAllowance", "education": "Education", "books": "BooksPeriodicals",
    "attire": "AttireAllowance", "fuel": "FuelCarReimbursement", "lta": "LTA",
    "bonus": "Bonus_8_33", "otherAllow": "OtherAllowance", "pf": "PF",
    "esic": "ESIC_Deduction", "pt": "ProfessionalTax", "epf": "EmployerContributionEPF",
    "mediclaim": "Mediclaim", "gratuity": "Gratuity", "benefitEsic": "ESIC_Benefit",
}


def settings_path() -> Path:
    configured = os.getenv("ENCORP_SETTINGS_FILE")
    if configured:
        return Path(configured)
    return Path(__file__).resolve().parents[1] / "settings.protected"


def load_protected_settings() -> dict[str, Any]:
    path = settings_path()
    if not path.is_file():
        return {}
    try:
        payload = json.loads(path.read_text(encoding="utf-8-sig"))
    except (OSError, json.JSONDecodeError) as exc:
        raise RuntimeError("The protected Encorp settings file is invalid.") from exc
    if not isinstance(payload, dict):
        raise RuntimeError("The protected Encorp settings file is invalid.")
    return payload


class DotNetCursor:
    def __init__(self, connection: Any) -> None:
        self.connection = connection
        self.reader = None
        self.description = None
        self.rowcount = -1

    def execute(self, statement: str, parameters: Any = None, *extra: Any) -> "DotNetCursor":
        if self.reader is not None:
            self.reader.Close()
            self.reader = None
        if parameters is None:
            values = []
        elif extra:
            values = [parameters, *extra]
        elif isinstance(parameters, (list, tuple)):
            values = list(parameters)
        else:
            values = [parameters]

        command = self.connection.CreateCommand()
        parts = statement.split("?")
        if len(parts) - 1 != len(values):
            raise ValueError("SQL parameter count does not match the query.")
        command.CommandText = "".join(
            part + (f"@p{index}" if index < len(values) else "")
            for index, part in enumerate(parts)
        )
        for index, value in enumerate(values):
            command.Parameters.AddWithValue(f"@p{index}", self._parameter(value))

        if statement.lstrip().upper().startswith("SELECT"):
            self.reader = command.ExecuteReader()
            self.description = [(self.reader.GetName(i),) for i in range(self.reader.FieldCount)]
        else:
            self.rowcount = int(command.ExecuteNonQuery())
        return self

    @staticmethod
    def _parameter(value: Any) -> Any:
        from System import DBNull, Double, Int32, String

        if value is None:
            return DBNull.Value
        if isinstance(value, bool):
            return value
        if isinstance(value, int):
            return Int32(value)
        if isinstance(value, float):
            return Double(value)
        return String(str(value))

    @staticmethod
    def _value(value: Any) -> Any:
        from System import DBNull

        if value is DBNull.Value:
            return None
        if all(hasattr(value, name) for name in ("Year", "Month", "Day")):
            return dt.date(value.Year, value.Month, value.Day)
        return value

    def fetchone(self) -> tuple | None:
        if self.reader is None or not self.reader.Read():
            return None
        return tuple(self._value(self.reader.GetValue(i)) for i in range(self.reader.FieldCount))

    def fetchall(self) -> list[tuple]:
        rows = []
        while True:
            row = self.fetchone()
            if row is None:
                return rows
            rows.append(row)

    def close(self) -> None:
        if self.reader is not None:
            self.reader.Close()
            self.reader = None


class DotNetConnection:
    def __init__(self, connection_string: str) -> None:
        try:
            import clr
            clr.AddReference("System.Data")
            from System.Data.SqlClient import SqlConnection
        except Exception as exc:
            raise RuntimeError("The Encorp SQL Server component is not installed.") from exc
        self.connection = SqlConnection(connection_string)
        self.connection.Open()

    def cursor(self) -> DotNetCursor:
        return DotNetCursor(self.connection)

    def commit(self) -> None:
        return None

    def close(self) -> None:
        self.connection.Close()
        self.connection.Dispose()


def get_connection() -> Any:
    settings = load_protected_settings()
    connection_string = os.getenv("ENCORP_SQL_CONNECTION_STRING") or settings.get("sql_connection_string")
    # Allow assembling a connection string from individual environment variables when a single
    # connection string is not provided. This is convenient for Render and other deployment
    # platforms where secrets are stored separately.
    if not connection_string:
        host = os.getenv("ENCORP_SQL_HOST")
        database = os.getenv("ENCORP_SQL_DATABASE")
        user = os.getenv("ENCORP_SQL_USER")
        password = os.getenv("ENCORP_SQL_PASSWORD")
        if host and database and user and password:
            # Normalize host (allow host[:port] or host,port formats)
            connection_string = f"Server=tcp:{host};Initial Catalog={database};User Id={user};Password={password};"
    if not connection_string:
        raise RuntimeError("Encorp database settings have not been configured.")
    # Ensure encryption settings are present for environments (such as Azure) that require TLS.
    if "encrypt" not in connection_string.lower():
        if not connection_string.endswith(";"):
            connection_string += ";"
        connection_string += "Encrypt=True;TrustServerCertificate=True;"
    return DotNetConnection(str(connection_string))


def _values(record: dict[str, Any]) -> list[dict[str, Any]]:
    raw = record.get("values", [])
    if isinstance(raw, str):
        try:
            raw = json.loads(raw)
        except json.JSONDecodeError:
            raw = []
    return [item for item in raw if isinstance(item, dict)] if isinstance(raw, list) else []


def _number(value: Any) -> float:
    try:
        return float(value or 0)
    except (TypeError, ValueError):
        return 0.0


def _row_to_record(row: tuple, columns: list[str]) -> dict[str, Any]:
    data = dict(zip(columns, row))
    values = data.pop("ComponentValues", None) or "[]"
    doj = data.pop("DOJ", None)
    return {
        "id": data.pop("Id", None), "pan": data.pop("PAN", ""),
        "employee_name": data.pop("EmployeeName", "") or "",
        "department": data.pop("Department", "") or "",
        "designation": data.pop("Designation", "") or "",
        "doj": doj.isoformat() if doj else "", "values": values, **data,
    }


def _record_columns(record: dict[str, Any]) -> dict[str, Any]:
    values = _values(record)
    by_id = {str(item.get("id")): _number(item.get("monthly")) for item in values}
    earnings = sum(by_id.get(key, 0) for key in ("basic", "hra", "medical", "conveyance", "education", "books", "attire", "fuel", "lta", "bonus", "otherAllow"))
    deductions = sum(by_id.get(key, 0) for key in ("pf", "esic", "pt"))
    benefits = sum(by_id.get(key, 0) for key in ("epf", "mediclaim", "gratuity", "benefitEsic"))
    columns = {
        "PAN": str(record.get("pan", "")).strip().upper(),
        "EmployeeName": str(record.get("employee_name", record.get("employeeName", ""))).strip() or None,
        "Department": str(record.get("department", "")).strip() or None,
        "Designation": str(record.get("designation", "")).strip() or None,
        "DOJ": record.get("doj") or None,
        "GrossSalaryPayable": earnings, "DeductionTotal": deductions,
        "CashInHand": earnings - deductions, "BenefitTotal": benefits,
        "TotalCTC": (earnings + benefits) * 12, "GrossMonthly": earnings,
        "DeductionMonthly": deductions, "CashInHandSummary": earnings - deductions,
        "Benefits": benefits, "ComponentValues": json.dumps(values, ensure_ascii=False),
    }
    for value_id, column in COMPONENT_COLUMNS.items():
        columns[column] = by_id.get(value_id, 0)
    return columns


def list_records(conn: Any) -> list[dict[str, Any]]:
    cursor = conn.cursor()
    cursor.execute(f"SELECT * FROM {TABLE} ORDER BY PAN")
    columns = [column[0] for column in cursor.description]
    rows = cursor.fetchall()
    cursor.close()
    return [_row_to_record(row, columns) for row in rows]


def find_by_pan(conn: Any, pan: str) -> dict[str, Any] | None:
    cursor = conn.cursor()
    cursor.execute(f"SELECT * FROM {TABLE} WHERE PAN = ?", str(pan or "").strip().upper())
    row = cursor.fetchone()
    cursor.close()
    return _row_to_record(row, [column[0] for column in cursor.description]) if row else None


def save_record(conn: Any, record: dict[str, Any], update: bool = False) -> dict[str, Any]:
    data = _record_columns(record)
    if not data["PAN"]:
        raise ValueError("A PAN number is required.")
    cursor = conn.cursor()
    existing = find_by_pan(conn, data["PAN"])
    if update and not existing:
        raise LookupError("No salary record exists for this PAN. Save it first.")
    if not update and existing:
        raise ValueError("A salary record already exists for this PAN. Use Update instead.")
    if update:
        assignments = ", ".join(f"[{name}] = ?" for name in data if name != "PAN")
        params = [value for name, value in data.items() if name != "PAN"] + [data["PAN"]]
        cursor.execute(f"UPDATE {TABLE} SET {assignments} WHERE [PAN] = ?", params)
    else:
        columns = ", ".join(f"[{name}]" for name in data)
        placeholders = ", ".join("?" for _ in data)
        cursor.execute(f"INSERT INTO {TABLE} ({columns}) VALUES ({placeholders})", list(data.values()))
    conn.commit()
    cursor.close()
    saved = find_by_pan(conn, data["PAN"])
    if not saved:
        raise RuntimeError("The salary record could not be verified after saving.")
    return saved


def delete_record(conn: Any, pan: str) -> bool:
    cursor = conn.cursor()
    cursor.execute(f"DELETE FROM {TABLE} WHERE PAN = ?", str(pan or "").strip().upper())
    conn.commit()
    deleted = cursor.rowcount > 0
    cursor.close()
    return deleted
