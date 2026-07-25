# ingestion/Dockerfile
FROM python:3.12-slim
WORKDIR /app
# libreoffice-draw: headless EMF/WMF->PNG conversion (see app/vision/emf_converter.py) --
# Word embeds these vector metafiles for pasted Visio/PowerPoint diagrams, and they
# aren't real raster images the vision endpoint can ever describe as-is regardless of
# mimeType label. LibreOffice is the same suite that authors these formats, so its
# import filters are the most reliable available in a Linux container.
RUN apt-get update \
    && apt-get install -y --no-install-recommends tesseract-ocr poppler-utils libreoffice-draw \
    && rm -rf /var/lib/apt/lists/*
COPY pyproject.toml ./
COPY app ./app
RUN pip install --no-cache-dir .
EXPOSE 8000
CMD ["uvicorn", "app.main:app", "--host", "0.0.0.0", "--port", "8000"]
