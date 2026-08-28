# Dynamic QR Redirect

[![Python](https://img.shields.io/badge/Python-3.10%2B-3776AB?logo=python&logoColor=white)](https://www.python.org/)
[![FastAPI](https://img.shields.io/badge/FastAPI-0.115-009688?logo=fastapi&logoColor=white)](https://fastapi.tiangolo.com/)
[![Tests](https://img.shields.io/badge/tests-pytest-0A9EDC?logo=pytest&logoColor=white)](https://pytest.org/)

Microsserviço FastAPI para QR Codes dinâmicos. O QR Code aponta para `/ref` e o destino pode ser alterado no servidor por meio de `TARGET_URL`, sem precisar gerar uma nova imagem.

## Estrutura

```text
app/       API FastAPI
cli/       Gerador de QR Code
tests/     Testes automatizados
```

## Instalação

Requer Python 3.10 ou superior.

```bash
python -m venv .venv
# Windows PowerShell
.\.venv\Scripts\Activate.ps1
# Linux/macOS
source .venv/bin/activate
pip install -r requirements.txt
cp .env.example .env
```

No Windows CMD, ative com `.venv\Scripts\activate.bat`. Edite `.env` e defina `TARGET_URL`.

## Executar a API

```bash
uvicorn app.main:app --host 0.0.0.0 --port 8000
```

Acesse `http://localhost:8000/docs` para Swagger UI. O endpoint `/ref` responde com HTTP 302, enquanto `/health` é adequado para health checks.

## Gerar o QR Code

```bash
python -m cli.generate_qr --url https://seu-app.onrender.com/ref
python -m cli.generate_qr --url https://seu-app.onrender.com/ref --output meu_qrcode.png
```

O caminho retornado é absoluto e funciona em Windows, Linux e macOS.

## Testes

```bash
pytest
```

## Deploy no Render

1. Crie um **Web Service** conectado ao repositório GitHub.
2. Use `pip install -r requirements.txt` como **Build Command**.
3. Use `uvicorn app.main:app --host 0.0.0.0 --port $PORT` como **Start Command**.
4. Em **Environment**, crie `TARGET_URL` com a URL final desejada.
5. Após o deploy, gere o QR Code apontando para `https://seu-servico.onrender.com/ref`.

O Render pode suspender serviços gratuitos após inatividade; o primeiro acesso pode levar alguns segundos.