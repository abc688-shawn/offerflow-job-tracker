FROM python:3.12-slim

ENV PYTHONDONTWRITEBYTECODE=1 \
    PYTHONUNBUFFERED=1 \
    OFFERFLOW_HOST=0.0.0.0 \
    OFFERFLOW_DB=/data/offerflow.db \
    PORT=8080

WORKDIR /app

COPY index.html styles.css app.js server.py docker-entrypoint.sh ./

RUN mkdir -p /data \
    && groupadd --system offerflow \
    && useradd --system --gid offerflow --home-dir /app offerflow \
    && chown offerflow:offerflow /data \
    && chmod 755 /app/docker-entrypoint.sh

EXPOSE 8080

ENTRYPOINT ["/app/docker-entrypoint.sh"]
CMD ["python", "server.py"]
