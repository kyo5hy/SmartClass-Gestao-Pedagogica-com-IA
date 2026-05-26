# python_ia/Dockerfile
FROM python:3.11-slim

WORKDIR /app/python_ia

# Instala dependências do sistema necessárias para OpenCV e Dlib no Linux ARM
RUN apt-get update && apt-get install -y \
    libgl1-mesa-glx \
    libglib2.0-0 \
    build-essential \
    cmake \
    libopenblas-dev \
    liblapack-dev \
    libx11-dev \
    && rm -rf /var/lib/apt/lists/*

# Copia o requirements.txt (vamos criá-lo no próximo passo)
COPY requirements.txt .

# Instala as dependências Python
RUN pip install --no-cache-dir -r requirements.txt

# Copia o código da IA
COPY . .

EXPOSE 8000

# Inicia a IA
CMD ["python", "main.py"]