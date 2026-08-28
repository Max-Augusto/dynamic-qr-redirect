"""API e interface web para criação de QR Codes dinâmicos."""

from datetime import datetime, timezone
from functools import lru_cache
from io import BytesIO
import json
import os
from pathlib import Path
import secrets
from typing import Any
from urllib.parse import urlparse

import qrcode
from dotenv import load_dotenv
from fastapi import FastAPI, HTTPException, Request
from fastapi.responses import HTMLResponse, RedirectResponse, StreamingResponse
from pydantic import BaseModel, Field, field_validator

load_dotenv()
DATA_FILE = Path(os.getenv("DATA_FILE", "data/links.json"))


class LinkCreate(BaseModel):
    """Dados necessários para criar um QR Code dinâmico."""

    target_url: str = Field(..., min_length=1)
    title: str = Field(default="Meu QR Code", max_length=120)
    slug: str | None = Field(default=None, max_length=40)

    @field_validator("target_url")
    @classmethod
    def valid_url(cls, value: str) -> str:
        """Aceita somente URLs HTTP/HTTPS com host."""
        parsed = urlparse(value)
        if parsed.scheme not in {"http", "https"} or not parsed.netloc:
            raise ValueError("A URL deve começar com http:// ou https://")
        return value

    @field_validator("slug")
    @classmethod
    def valid_slug(cls, value: str | None) -> str | None:
        """Garante que o identificador seja seguro para uma URL."""
        if value is not None and (not value or not value.replace("-", "").isalnum()):
            raise ValueError("O slug deve conter apenas letras, números e hífen")
        return value


class LinkUpdate(BaseModel):
    """Campos editáveis de um QR Code existente."""

    target_url: str = Field(..., min_length=1)
    title: str = Field(..., max_length=120)

    @field_validator("target_url")
    @classmethod
    def valid_url(cls, value: str) -> str:
        """Aceita somente URLs HTTP/HTTPS com host."""
        parsed = urlparse(value)
        if parsed.scheme not in {"http", "https"} or not parsed.netloc:
            raise ValueError("A URL deve começar com http:// ou https://")
        return value


def read_links() -> dict[str, dict[str, Any]]:
    """Lê o catálogo persistido ou retorna um catálogo vazio."""
    if not DATA_FILE.exists():
        return {}
    try:
        return json.loads(DATA_FILE.read_text(encoding="utf-8"))
    except (json.JSONDecodeError, OSError):
        return {}


def write_links(links: dict[str, dict[str, Any]]) -> None:
    """Persiste os links em JSON, criando a pasta necessária."""
    DATA_FILE.parent.mkdir(parents=True, exist_ok=True)
    DATA_FILE.write_text(json.dumps(links, ensure_ascii=False, indent=2), encoding="utf-8")


def find_link(code_id: str) -> dict[str, Any]:
    """Busca um link ou retorna HTTP 404."""
    link = read_links().get(code_id)
    if link is None:
        raise HTTPException(status_code=404, detail="QR Code não encontrado")
    return link


@lru_cache
def get_target_url() -> str:
    """Mantém compatibilidade com a rota legada baseada em TARGET_URL."""
    return os.getenv("TARGET_URL", "https://example.com")


app = FastAPI(
    title="Dynamic QR Redirect",
    description="Crie QR Codes dinâmicos e altere seus destinos sem reimprimir o código.",
    version="2.0.0",
)


@app.get("/", response_class=HTMLResponse, include_in_schema=False)
async def root() -> HTMLResponse:
    """Exibe o painel intuitivo de criação e gerenciamento."""
    return HTMLResponse(WEB_APP)


@app.get("/api/links", summary="Listar QR Codes")
async def list_links() -> list[dict[str, Any]]:
    """Retorna os QR Codes criados."""
    return list(read_links().values())


@app.post("/api/links", status_code=201, summary="Criar QR Code dinâmico")
async def create_link(payload: LinkCreate) -> dict[str, Any]:
    """Cria um identificador permanente para o redirecionamento."""
    links = read_links()
    code_id = payload.slug or secrets.token_urlsafe(5).replace("_", "-").replace("/", "-")
    while code_id in links:
        code_id = secrets.token_urlsafe(5).replace("_", "-").replace("/", "-")
    now = datetime.now(timezone.utc).isoformat()
    link = {"id": code_id, "title": payload.title, "target_url": payload.target_url, "created_at": now, "updated_at": now}
    links[code_id] = link
    write_links(links)
    return link


@app.get("/api/links/{code_id}", summary="Consultar QR Code")
async def get_link(code_id: str) -> dict[str, Any]:
    """Retorna os dados de um QR Code."""
    return find_link(code_id)


@app.put("/api/links/{code_id}", summary="Alterar destino do QR Code")
async def update_link(code_id: str, payload: LinkUpdate) -> dict[str, Any]:
    """Altera o destino sem mudar o endereço do QR Code."""
    links = read_links()
    link = links.get(code_id)
    if link is None:
        raise HTTPException(status_code=404, detail="QR Code não encontrado")
    link.update({"title": payload.title, "target_url": payload.target_url, "updated_at": datetime.now(timezone.utc).isoformat()})
    write_links(links)
    return link


@app.get("/q/{code_id}", status_code=302, summary="Redirecionar QR Code")
async def redirect_by_id(code_id: str) -> RedirectResponse:
    """Redireciona para o destino atual do QR Code."""
    return RedirectResponse(url=find_link(code_id)["target_url"], status_code=302)


@app.get("/q/{code_id}/qr", summary="Baixar imagem do QR Code")
async def qr_image(code_id: str, request: Request) -> StreamingResponse:
    """Gera a imagem PNG com o endereço permanente do QR Code."""
    link = find_link(code_id)
    qr = qrcode.QRCode(error_correction=qrcode.constants.ERROR_CORRECT_H, box_size=10, border=4)
    qr.add_data(f"{str(request.base_url).rstrip('/')}/q/{link['id']}")
    qr.make(fit=True)
    image = qr.make_image(fill_color="black", back_color="white")
    buffer = BytesIO()
    image.save(buffer, format="PNG")
    buffer.seek(0)
    return StreamingResponse(buffer, media_type="image/png")


@app.get("/health", summary="Verificar disponibilidade", tags=["Service"])
async def health() -> dict[str, str]:
    """Health check para plataformas de deploy."""
    return {"status": "ok"}


@app.get("/ref", include_in_schema=False)
async def redirect_ref() -> RedirectResponse:
    """Mantém a rota legada baseada em TARGET_URL."""
    return RedirectResponse(url=get_target_url(), status_code=302)


WEB_APP = """<!DOCTYPE html>
<html lang="pt-BR">
<head>
<meta charset="UTF-8"><meta name="viewport" content="width=device-width,initial-scale=1.0">
<title>QR Code Dinâmico</title>
<style>
:root{font-family:system-ui,-apple-system,sans-serif;color:#17332b;background:#f5f8f7}*{box-sizing:border-box}body{margin:0}button,input{font:inherit}header{padding:24px max(24px,calc((100vw - 1160px)/2));background:#fff;border-bottom:1px solid #dbe7e2}.brand{font-size:1.2rem;font-weight:800;color:#17624e}.brand span{color:#17332b}main{width:min(1160px,calc(100% - 48px));margin:44px auto}h1{margin:0;font-size:clamp(2rem,4vw,3rem);letter-spacing:0}.intro{margin:10px 0 34px;color:#5d706a;font-size:1.05rem}.layout{display:grid;grid-template-columns:minmax(0,1.3fr) minmax(300px,.7fr);gap:24px;align-items:start}.panel{padding:28px;background:#fff;border:1px solid #dbe7e2;border-radius:12px;box-shadow:0 10px 30px #17332b0d}h2{margin:0 0 24px;font-size:1.15rem}label{display:block;margin:18px 0 8px;font-weight:650}input{width:100%;padding:13px 14px;border:1px solid #cbdad4;border-radius:8px;color:#17332b}input:focus{outline:3px solid #b7e3d4;border-color:#1f8065}.hint{margin:8px 0 0;color:#73857f;font-size:.88rem}button{margin-top:24px;padding:13px 20px;border:0;border-radius:8px;background:#1f8065;color:#fff;font-weight:750;cursor:pointer}button:hover{background:#17624e}button.secondary{background:#e5efeb;color:#17624e}button.secondary:hover{background:#d3e4dd}.qr-empty{display:grid;place-items:center;min-height:260px;color:#81918c;text-align:center;border:1px dashed #cbdad4;border-radius:8px}.qr-result{text-align:center}.qr-result img{width:min(100%,240px);padding:12px;border:1px solid #dbe7e2;border-radius:8px}.short-url{display:block;margin:14px 0;padding:11px;overflow-wrap:anywhere;background:#f0f6f3;border-radius:6px;color:#17624e}.links{margin-top:24px}.link-item{display:flex;justify-content:space-between;gap:16px;align-items:center;padding:16px 0;border-top:1px solid #e3ece8}.link-item strong,.link-item small{display:block;overflow-wrap:anywhere}.link-item small{margin-top:5px;color:#73857f}.edit{margin-top:0;white-space:nowrap}.message{min-height:22px;margin-top:14px;color:#b4492f;font-size:.92rem}@media(max-width:760px){main{width:min(100% - 28px,560px);margin:30px auto}.layout{grid-template-columns:1fr}header{padding:20px 14px}.panel{padding:22px}}
</style></head><body><header><div class="brand">short<span>QR</span></div></header><main><h1>Crie seu QR Code dinâmico</h1><p class="intro">Gere uma vez e altere o destino quando quiser, sem precisar criar outro QR Code.</p><div class="layout"><section class="panel"><h2>1. Configure seu link</h2><form id="link-form"><label for="title">Título do link</label><input id="title" value="Meu QR Code" required placeholder="Ex.: Cardápio da loja"><label for="target">URL original</label><input id="target" type="url" required placeholder="https://seu-site.com/pagina"><p class="hint">Esse é o destino que poderá ser alterado depois.</p><label for="slug">Slug personalizado <span class="hint">(opcional)</span></label><input id="slug" pattern="[A-Za-z0-9-]+" placeholder="ex.: cardapio"><button type="submit">Gerar QR Code</button><div class="message" id="message" role="alert"></div></form></section><section class="panel qr-result" id="result"><h2>2. Seu QR Code</h2><div class="qr-empty">Preencha a URL ao lado<br>e clique em “Gerar QR Code”.</div></section></div><section class="panel links"><h2>Seus links</h2><div id="links-list">Carregando...</div></section></main>
<script>
const form=document.getElementById('link-form'),message=document.getElementById('message'),result=document.getElementById('result'),list=document.getElementById('links-list');let selectedId=null;const esc=value=>String(value).replace(/[&<>'"]/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;',"'":'&#39;','"':'&quot;'}[c]));
async function loadLinks(){const response=await fetch('/api/links'),links=await response.json();list.innerHTML=links.length?links.map(link=>`<div class="link-item"><div><strong>${esc(link.title)}</strong><small>${esc(link.target_url)}</small><small>QR: /q/${esc(link.id)}</small></div><button class="secondary edit" onclick="editLink('${esc(link.id)}')">Editar destino</button></div>`).join(''):'<p class="hint">Seus QR Codes aparecerão aqui.</p>'}
function showResult(link){selectedId=link.id;result.innerHTML=`<h2>2. Seu QR Code está pronto</h2><img src="/q/${encodeURIComponent(link.id)}/qr" alt="QR Code de ${esc(link.title)}"><code class="short-url">/q/${esc(link.id)}</code><p class="hint">Este endereço não muda quando você editar o destino.</p><button class="secondary" onclick="editLink('${esc(link.id)}')">Alterar destino</button>`}
form.addEventListener('submit',async e=>{e.preventDefault();message.textContent='';const payload={title:document.getElementById('title').value,target_url:document.getElementById('target').value,slug:document.getElementById('slug').value||null};const response=await fetch('/api/links',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(payload)}),data=await response.json();if(!response.ok){message.textContent=data.detail?.[0]?.msg||data.detail||'Não foi possível criar o QR Code.';return}showResult(data);await loadLinks()});
window.editLink=async id=>{const response=await fetch('/api/links/'+encodeURIComponent(id)),link=await response.json();document.getElementById('title').value=link.title;document.getElementById('target').value=link.target_url;selectedId=id;form.querySelector('button').textContent='Salvar novo destino';form.onsubmit=async e=>{e.preventDefault();const update={title:document.getElementById('title').value,target_url:document.getElementById('target').value},r=await fetch('/api/links/'+encodeURIComponent(selectedId),{method:'PUT',headers:{'Content-Type':'application/json'},body:JSON.stringify(update)}),updated=await r.json();if(!r.ok){message.textContent=updated.detail?.[0]?.msg||updated.detail||'Não foi possível salvar.';return}message.textContent='Destino atualizado.';form.querySelector('button').textContent='Gerar QR Code';showResult(updated);await loadLinks()};form.scrollIntoView({behavior:'smooth'})};loadLinks();
</script></body></html>"""
