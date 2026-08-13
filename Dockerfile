FROM python:3.12-slim

WORKDIR /app

RUN apt-get update && apt-get install -y \
    mono-runtime mono-devel \
    && rm -rf /var/lib/apt/lists/*

COPY requirements.txt .
RUN pip install --no-cache-dir -r requirements.txt

COPY . .

ENV HOST=0.0.0.0 PORT=3000 PYTHONNET_RUNTIME=mono PYTHONUNBUFFERED=1
EXPOSE 3000
CMD ["python", "-m", "encorp_app"]
