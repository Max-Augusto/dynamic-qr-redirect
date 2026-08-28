"""Gera QR Codes PNG para URLs públicas de redirecionamento."""

import argparse
from pathlib import Path
import sys
from urllib.parse import urlparse

import qrcode
from qrcode.constants import ERROR_CORRECT_H


def validate_url(url: str) -> str:
    """Valida e retorna uma URL HTTP ou HTTPS.

    Args:
        url: URL a ser validada.

    Raises:
        ValueError: Se a URL não usar HTTP/HTTPS ou não tiver host.
    """
    parsed_url = urlparse(url)
    if parsed_url.scheme not in {"http", "https"} or not parsed_url.netloc:
        raise ValueError("a URL deve começar com http:// ou https:// e ter um host")
    return url


def generate_qr_code(
    url: str,
    output_path: str | Path = "qrcode_dinamico.png",
    box_size: int = 12,
    border: int = 4,
) -> Path:
    """Gera e salva um QR Code PNG em alta resolução.

    Args:
        url: URL pública do endpoint de redirecionamento.
        output_path: Caminho do arquivo PNG de saída.
        box_size: Tamanho de cada módulo em pixels.
        border: Margem de segurança em módulos.

    Returns:
        Caminho absoluto e normalizado do arquivo gerado.

    Raises:
        ValueError: Se a URL ou os parâmetros de imagem forem inválidos.
    """
    validate_url(url)
    if box_size < 1 or border < 4:
        raise ValueError("box_size deve ser positivo e border deve ser >= 4")

    destination = Path(output_path).expanduser().resolve()
    destination.parent.mkdir(parents=True, exist_ok=True)

    qr = qrcode.QRCode(
        version=None,
        error_correction=ERROR_CORRECT_H,
        box_size=box_size,
        border=border,
    )
    qr.add_data(url)
    qr.make(fit=True)
    image = qr.make_image(fill_color="black", back_color="white")
    image.save(destination)
    return destination


def build_parser() -> argparse.ArgumentParser:
    """Cria o parser de argumentos do CLI."""
    parser = argparse.ArgumentParser(
        description="Gera QR Code PNG para uma URL de redirecionamento dinâmico."
    )
    parser.add_argument("--url", required=True, help="URL HTTP/HTTPS do servidor.")
    parser.add_argument(
        "-o", "--output", default="qrcode_dinamico.png", help="Arquivo PNG de saída."
    )
    parser.add_argument("--box-size", type=int, default=12, help="Pixels por módulo.")
    parser.add_argument("--border", type=int, default=4, help="Margem em módulos (mínimo 4).")
    return parser


def main() -> int:
    """Executa o CLI e retorna o código de saída do processo."""
    args = build_parser().parse_args()
    try:
        output = generate_qr_code(args.url, args.output, args.box_size, args.border)
    except ValueError as error:
        print(f"Erro: {error}", file=sys.stderr)
        return 1
    print(f"QR Code gerado com sucesso: {output}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())