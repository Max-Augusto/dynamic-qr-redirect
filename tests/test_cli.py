"""Testes do gerador de QR Code."""

from pathlib import Path

import pytest

from cli.generate_qr import generate_qr_code


def test_generate_qr_code_creates_png(tmp_path: Path) -> None:
    """Gera um PNG no caminho absoluto solicitado."""
    output = generate_qr_code("https://example.com/ref", tmp_path / "code.png")

    assert output == (tmp_path / "code.png").resolve()
    assert output.is_file()
    assert output.read_bytes().startswith(b"\x89PNG\r\n\x1a\n")


@pytest.mark.parametrize("url", ["example.com", "ftp://example.com", "", "https://"])
def test_generate_qr_code_rejects_invalid_urls(url: str, tmp_path: Path) -> None:
    """Recusa URLs sem esquema HTTP/HTTPS e host válido."""
    with pytest.raises(ValueError):
        generate_qr_code(url, tmp_path / "code.png")