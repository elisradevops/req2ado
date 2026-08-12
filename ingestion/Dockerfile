# ingestion/Dockerfile
FROM python:3.12-slim
WORKDIR /app
# libreoffice-draw: headless EMF/WMF->PNG conversion (see app/vision/emf_converter.py) --
# Word embeds these vector metafiles for pasted Visio/PowerPoint diagrams, and they
# aren't real raster images the vision endpoint can ever describe as-is regardless of
# mimeType label. LibreOffice is the same suite that authors these formats, so its
# import filters are the most reliable available in a Linux container.
# libreoffice-writer: docx->PDF conversion (see app/loaders/docx_pagination.py) -- a
# docx file carries no page numbers anywhere in its own file format (pagination is a
# rendering-time computation, not document structure), so real page numbers for a
# docx's own blocks/tables/figures are derived by converting it to PDF and aligning
# against the PDF's own real per-page text. libreoffice-draw alone does NOT include
# the Writer application layer needed for this -- confirmed via a real conversion,
# `soffice --headless --convert-to pdf` fails on a .docx without it.
# fonts-liberation/fonts-crosextra-carlito/fonts-crosextra-caladea: metric-compatible
# substitutes for Arial/Times/Courier, Calibri, and Cambria respectively -- without
# them LibreOffice re-flows a document using its own fallback fonts, and page breaks
# (and therefore the page numbers derived from them) can shift significantly on a
# long document using any of these common Office defaults.
RUN apt-get update \
    && apt-get install -y --no-install-recommends \
       tesseract-ocr poppler-utils libreoffice-draw libreoffice-writer \
       fonts-liberation fonts-crosextra-carlito fonts-crosextra-caladea \
    && rm -rf /var/lib/apt/lists/*
COPY pyproject.toml ./
COPY app ./app
RUN pip install --no-cache-dir .
EXPOSE 8000
CMD ["uvicorn", "app.main:app", "--host", "0.0.0.0", "--port", "8000"]
