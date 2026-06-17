# Markdown Bridge render service (Doc storage 4/4, baton d216b2fb).
# Host-agnostic container: runs on Cloud Run / Fly / Railway / a cheap VPS — anywhere that runs Docker.
# Carries pandoc (docx via the house reference.docx; pdf via weasyprint, no LaTeX → lean image).
FROM python:3.12-slim

# Pandoc (pinned) + weasyprint's native deps (pango/cairo/gdk-pixbuf) + base fonts.
ARG PANDOC_VERSION=3.6.1
RUN apt-get update && apt-get install -y --no-install-recommends \
      curl ca-certificates \
      libpango-1.0-0 libpangocairo-1.0-0 libgdk-pixbuf-2.0-0 libcairo2 libffi8 \
      fonts-dejavu fonts-liberation \
  && curl -fsSL -o /tmp/pandoc.deb \
      "https://github.com/jgm/pandoc/releases/download/${PANDOC_VERSION}/pandoc-${PANDOC_VERSION}-1-amd64.deb" \
  && dpkg -i /tmp/pandoc.deb \
  && rm /tmp/pandoc.deb \
  && apt-get purge -y curl \
  && apt-get clean && rm -rf /var/lib/apt/lists/*

WORKDIR /app
COPY requirements.txt .
RUN pip install --no-cache-dir -r requirements.txt
COPY app.py .

# Cloud Run / Fly inject $PORT; default 8080 for local docker run.
ENV PORT=8080
CMD ["sh", "-c", "uvicorn app:app --host 0.0.0.0 --port ${PORT}"]
