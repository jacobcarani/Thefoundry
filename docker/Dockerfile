FROM dolfinx/dolfinx:stable

WORKDIR /workspace

COPY backend/requirements.txt /workspace/backend/requirements.txt
RUN pip install --no-cache-dir -r /workspace/backend/requirements.txt

COPY backend /workspace/backend

WORKDIR /workspace/backend
CMD ["python", "app.py"]
