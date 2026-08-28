import fs from "fs";
import path from "path";
import QRCode from "qrcode";

function validateUrl(url: string): string {
  try {
    const parsed = new URL(url);
    if ((parsed.protocol !== "http:" && parsed.protocol !== "https:") || !parsed.hostname) {
      throw new Error("a URL deve começar com http:// ou https:// e ter um host");
    }
    return url;
  } catch {
    throw new Error("a URL deve começar com http:// ou https:// e ter um host");
  }
}

export async function generateQrCode(
  url: string,
  outputPath: string = "qrcode_dinamico.png",
  boxSize: number = 12,
  border: number = 4
): Promise<string> {
  validateUrl(url);
  if (boxSize < 1 || border < 4) {
    throw new Error("box_size deve ser positivo e border deve ser >= 4");
  }

  const destination = path.resolve(outputPath);
  const dir = path.dirname(destination);
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true });
  }

  await QRCode.toFile(destination, url, {
    errorCorrectionLevel: "H",
    margin: border,
    scale: boxSize,
    color: {
      dark: "#000000",
      light: "#ffffff",
    },
  });

  return destination;
}

async function main() {
  const args = process.argv.slice(2);
  let url = "";
  let output = "qrcode_dinamico.png";
  let boxSize = 12;
  let border = 4;

  for (let i = 0; i < args.length; i++) {
    if (args[i] === "--url" && args[i + 1]) {
      url = args[++i];
    } else if ((args[i] === "-o" || args[i] === "--output") && args[i + 1]) {
      output = args[++i];
    } else if (args[i] === "--box-size" && args[i + 1]) {
      boxSize = parseInt(args[++i], 10);
    } else if (args[i] === "--border" && args[i + 1]) {
      border = parseInt(args[++i], 10);
    }
  }

  if (!url) {
    console.error("Uso: npx tsx cli/generate_qr.ts --url <URL> [-o <saida.png>] [--box-size 12] [--border 4]");
    process.exit(1);
  }

  try {
    const dest = await generateQrCode(url, output, boxSize, border);
    console.log(`QR Code gerado com sucesso: ${dest}`);
  } catch (err: any) {
    console.error(`Erro: ${err?.message || err}`);
    process.exit(1);
  }
}

if (process.argv[1]?.endsWith("generate_qr.ts") || process.argv[1]?.endsWith("generate_qr.js")) {
  main();
}
