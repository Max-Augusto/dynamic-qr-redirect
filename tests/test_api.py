"""Testes dos endpoints da API."""

from pathlib import Path

from fastapi.testclient import TestClient

import app.main as api
from app.main import app, get_target_url


client = TestClient(app)


def test_root_returns_service_information() -> None:
    """A raiz apresenta a tela inicial orientada ao usuário."""
    response = client.get("/")

    assert response.status_code == 200
    assert "QR Code Dinâmico" in response.text
    assert "Crie seu QR Code dinâmico" in response.text
    assert "Gerar QR Code" in response.text


def test_health_returns_ok() -> None:
    """O health check responde com status operacional."""
    response = client.get("/health")

    assert response.status_code == 200
    assert response.json() == {"status": "ok"}


def test_ref_redirects_to_configured_target() -> None:
    """A rota principal responde com redirect temporário."""
    get_target_url.cache_clear()
    response = client.get("/ref", follow_redirects=False)

    assert response.status_code == 302
    assert response.headers["location"] == "https://example.com"


def test_link_keeps_same_qr_address_after_target_update(tmp_path: Path, monkeypatch) -> None:
    """O endereço do QR permanece igual enquanto o destino é alterado."""
    monkeypatch.setattr(api, "DATA_FILE", tmp_path / "links.json")

    created = client.post(
        "/api/links",
        json={"title": "Campanha", "target_url": "https://example.com/old", "slug": "campanha"},
    )
    code_id = created.json()["id"]
    updated = client.put(
        f"/api/links/{code_id}",
        json={"title": "Campanha atualizada", "target_url": "https://example.com/new"},
    )
    redirect = client.get(f"/q/{code_id}", follow_redirects=False)

    assert updated.status_code == 200
    assert redirect.status_code == 302
    assert redirect.headers["location"] == "https://example.com/new"