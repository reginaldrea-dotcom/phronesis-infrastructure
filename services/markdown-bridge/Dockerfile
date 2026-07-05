# Markdown Bridge render service (Doc storage 4/4, baton d216b2fb).
# Host-agnostic container: runs on Cloud Run / Fly / Railway / a cheap VPS — anywhere that runs Docker.
# Carries pandoc (docx via the house reference.docx; pdf via weasyprint, no LaTeX → lean image).
FROM python:3.12-slim

# Pandoc (pinned) + weasyprint's native deps (pango/cairo/gdk-pixbuf) + base fonts.
ARG PANDOC_VERSION=3.6.1
# fonts-liberation already provides Liberation Sans (Arial-metric, house headings). fontconfig gives
# fc-cache. Gelasio (Georgia-metric body clone, Eames font-parity ask d96dcf7b) is fetched below.
RUN apt-get update && apt-get install -y --no-install-recommends \
      curl ca-certificates fontconfig \
      libpango-1.0-0 libpangocairo-1.0-0 libgdk-pixbuf-2.0-0 libcairo2 libffi8 \
      fonts-dejavu fonts-liberation \
  && curl -fsSL -o /tmp/pandoc.deb \
      "https://github.com/jgm/pandoc/releases/download/${PANDOC_VERSION}/pandoc-${PANDOC_VERSION}-1-amd64.deb" \
  && dpkg -i /tmp/pandoc.deb \
  && rm /tmp/pandoc.deb \
  # Gelasio — metric-compatible Georgia clone for docx/pdf typeface parity. Variable TTFs from the
  # google/fonts monorepo (fetched before curl is purged). fontconfig reads the internal family name
  # "Gelasio"; the [wght] in the filename is harmless.
  && mkdir -p /usr/share/fonts/truetype/gelasio \
  && curl -fsSL -o "/usr/share/fonts/truetype/gelasio/Gelasio[wght].ttf" \
      "https://github.com/google/fonts/raw/main/ofl/gelasio/Gelasio%5Bwght%5D.ttf" \
  && curl -fsSL -o "/usr/share/fonts/truetype/gelasio/Gelasio-Italic[wght].ttf" \
      "https://github.com/google/fonts/raw/main/ofl/gelasio/Gelasio-Italic%5Bwght%5D.ttf" \
  && fc-cache -f \
  && apt-get purge -y curl \
  && apt-get clean && rm -rf /var/lib/apt/lists/*

WORKDIR /app
COPY requirements.txt .
RUN pip install --no-cache-dir -r requirements.txt
COPY app.py .
# House styling assets baked in: reference.css (weasyprint pdf style), pagebreak.lua (one-token page
# break), reference.docx (the docx --reference-doc with the four callout Word styles — baked because
# the bridge's drive.file scope can't read a hand-uploaded file). Wired in app.py. Design: Eames d96dcf7b.
COPY reference.css pagebreak.lua reference.docx ./

# Cloud Run / Fly inject $PORT; default 8080 for local docker run.
ENV PORT=8080
CMD ["sh", "-c", "uvicorn app:app --host 0.0.0.0 --port ${PORT}"]
