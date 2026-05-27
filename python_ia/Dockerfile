FROM python:3.11-slim-bullseye
WORKDIR /app/python_ia

# Instala dependências do sistema necessárias para OpenCV e Dlib no Linux ARM
RUN apt-get update && apt-get install -y \
    libgl1 \
    libglib2.0-0 \
    build-essential \
    cmake \
    libopenblas-dev \
    liblapack-dev \
    libx11-dev \
    && rm -rf /var/lib/apt/lists/*

COPY requirements.txt .

# Força a instalação das versões mais recentes para evitar bug de segurança do PyTorch
RUN pip install --no-cache-dir --upgrade pip
RUN pip install --no-cache-dir -r requirements.txt
RUN pip install --no-cache-dir --upgrade ultralytics torch torchvision

COPY . .
EXPOSE 8000
CMD ["python", "main.py"]