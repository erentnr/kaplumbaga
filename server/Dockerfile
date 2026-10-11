# all dependencies are pure Python, so the small musl based image works
FROM python:3.14-alpine
# links the image on ghcr.io to the repository, the VPS prunes old images by it
LABEL org.opencontainers.image.source="https://github.com/erentnr/kaplumbaga"

ENV PYTHONDONTWRITEBYTECODE=1 PYTHONUNBUFFERED=1
WORKDIR /app

COPY requirements.txt .
RUN pip install --no-cache-dir -r requirements.txt

COPY game.py .

RUN adduser -S -D -H app
USER app

EXPOSE 8000
HEALTHCHECK --interval=30s --timeout=3s --start-period=30s --start-interval=2s \
  CMD python -c "import urllib.request; urllib.request.urlopen('http://127.0.0.1:8000/healthz')"

# Flask-SocketIO needs a single worker (no sticky sessions across workers);
# each thread serves one websocket connection. game.py caps sockets at
# MAX_SOCKETS (280), below the thread count, so health checks always get one.
CMD ["gunicorn", "--worker-class", "gthread", "--workers", "1", "--threads", "300", \
     "--bind", "0.0.0.0:8000", "--access-logfile", "-", "--no-control-socket", "game:app"]
