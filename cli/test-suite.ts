import http from "http";

const BASE_URL = "http://localhost:3000";

async function request(path: string, options: { method?: string; headers?: Record<string, string>; body?: any } = {}) {
  return new Promise<{ status: number; headers: http.IncomingHttpHeaders; body: any }>((resolve, reject) => {
    const url = new URL(path, BASE_URL);
    const postData = options.body ? (typeof options.body === "string" ? options.body : JSON.stringify(options.body)) : undefined;

    const req = http.request(
      url,
      {
        method: options.method || "GET",
        headers: {
          ...(postData ? { "Content-Type": "application/json", "Content-Length": Buffer.byteLength(postData) } : {}),
          ...(options.headers || {}),
        },
      },
      (res) => {
        let rawData = "";
        res.on("data", (chunk) => {
          rawData += chunk;
        });
        res.on("end", () => {
          let parsed = rawData;
          try {
            parsed = JSON.parse(rawData);
          } catch {}
          resolve({
            status: res.statusCode || 0,
            headers: res.headers,
            body: parsed,
          });
        });
      }
    );

    req.on("error", reject);
    if (postData) {
      req.write(postData);
    }
    req.end();
  });
}

let passed = 0;
let failed = 0;

function assert(condition: boolean, testName: string, detail?: string) {
  if (condition) {
    console.log(`  ✅ [PASS] ${testName}`);
    passed++;
  } else {
    console.error(`  ❌ [FAIL] ${testName}${detail ? ` -> ${detail}` : ""}`);
    failed++;
  }
}

async function runAllTests() {
  console.log("\n=======================================================");
  console.log("  INICIANDO BATERIA DE TESTES AUTOMATIZADOS DO SISTEMA");
  console.log("=======================================================\n");

  const testSlug = `test_${Date.now()}`;
  const targetUrl1 = "https://exemplo.com/pagina-original";
  const targetUrl2 = "https://exemplo.com/novo-destino-atualizado";

  // 1. Healthcheck
  console.log("1. Testando Integridade Básica do Servidor...");
  const healthRes = await request("/health");
  assert(healthRes.status === 200 && healthRes.body.status === "ok", "Endpoint /health responde 200 OK");

  // 2. Config Endpoint
  console.log("\n2. Testando Endpoint de Configuração Pública...");
  const configRes = await request("/api/config");
  assert(configRes.status === 200, "Endpoint /api/config responde 200");

  // 3. Security Headers
  console.log("\n3. Validando Cabeçalhos de Segurança HTTP...");
  assert(healthRes.headers["x-content-type-options"] === "nosniff", "Header X-Content-Type-Options: nosniff");
  assert(healthRes.headers["x-xss-protection"] === "1; mode=block", "Header X-XSS-Protection");
  assert(typeof healthRes.headers["content-security-policy"] === "string", "Header Content-Security-Policy presente");
  assert(healthRes.headers["x-powered-by"] === undefined, "Header X-Powered-By removido (anti-fingerprinting)");

  // 4. Security Validation: Rejeição de URLs inseguras / SSRF / protocolos inválidos
  console.log("\n4. Testando Proteções contra Links Inseguros e SSRF...");
  
  const ssrf1 = await request("/api/links", {
    method: "POST",
    body: { target_url: "http://localhost:8080/admin", title: "Localhost Test" },
  });
  assert(ssrf1.status === 422, "Bloqueio de localhost (SSRF)");

  const ssrf2 = await request("/api/links", {
    method: "POST",
    body: { target_url: "http://169.254.169.254/latest/meta-data", title: "Metadata Test" },
  });
  assert(ssrf2.status === 422, "Bloqueio de Cloud Instance Metadata IP (169.254.169.254)");

  const jsProto = await request("/api/links", {
    method: "POST",
    body: { target_url: "javascript:alert(1)", title: "XSS Proto Test" },
  });
  assert(jsProto.status === 422, "Bloqueio de protocolo malicioso 'javascript:'");

  const reservedSlug = await request("/api/links", {
    method: "POST",
    body: { target_url: "https://google.com", slug: "api" },
  });
  assert(reservedSlug.status === 422, "Bloqueio de slug reservado do sistema ('api')");

  // 5. Criação de Link Dinâmico com Sucesso
  console.log("\n5. Testando Criação de Link / QR Code Dinâmico...");
  const createRes = await request("/api/links", {
    method: "POST",
    body: {
      target_url: targetUrl1,
      title: "QR Cardápio Teste",
      slug: testSlug,
    },
  });
  assert(createRes.status === 201 && createRes.body.id === testSlug, "Criação de link com slug personalizado");
  assert(createRes.body.target_url === targetUrl1, "URL de destino salva corretamente");

  // 6. Listagem de Links
  console.log("\n6. Testando Listagem de Links...");
  const listRes = await request("/api/links");
  const found = Array.isArray(listRes.body) && listRes.body.some((l: any) => l.id === testSlug);
  assert(listRes.status === 200 && found, "Link criado aparece na listagem /api/links");

  // 7. Obtenção de link individual
  console.log("\n7. Testando Busca por ID...");
  const getRes = await request(`/api/links/${testSlug}`);
  assert(getRes.status === 200 && getRes.body.id === testSlug, `Busca por /api/links/${testSlug} retorna dados corretos`);

  // 8. Testando Redirecionamento Dinâmico (Rota /q/:id)
  console.log("\n8. Testando Redirecionamento em Tempo Real...");
  const redir1 = await request(`/q/${testSlug}`);
  assert(redir1.status === 302, "Redirecionamento HTTP 302 retornado");
  assert(redir1.headers.location === targetUrl1, `Local de redirecionamento bate com destino original (${targetUrl1})`);

  // 9. Atualização Dinâmica do Link de Destino (sem alterar o slug)
  console.log("\n9. Testando Alteração Dinâmica do Destino...");
  const updateRes = await request(`/api/links/${testSlug}`, {
    method: "PUT",
    body: {
      title: "QR Cardápio Atualizado",
      target_url: targetUrl2,
    },
  });
  assert(updateRes.status === 200, "Atualização do link responde 200");
  assert(updateRes.body.target_url === targetUrl2, "Nova URL de destino persistida com sucesso");

  // 10. Verificação do Novo Redirecionamento Instantâneo
  console.log("\n10. Verificando se o Redirecionamento mudou instantaneamente...");
  const redir2 = await request(`/q/${testSlug}`);
  assert(redir2.status === 302, "Redirecionamento HTTP 302 após update");
  assert(redir2.headers.location === targetUrl2, `Local de redirecionamento agora aponta para o novo destino (${targetUrl2})`);

  // 11. Testando Contagem de Cliques / Scans
  console.log("\n11. Testando Métricas de Escaneamento (Cliques)...");
  const linkStats = await request(`/api/links/${testSlug}`);
  assert(linkStats.body.clicks >= 2, `Cliques foram computados com precisão (${linkStats.body.clicks} scans registrados)`);

  // 12. Testando Geração de Imagem QR Code PNG
  console.log("\n12. Testando Geração de Imagem PNG do QR Code...");
  const qrPngRes = await request(`/q/${testSlug}/qr`);
  assert(qrPngRes.status === 200, "Endpoint de QR PNG responde 200");
  assert(qrPngRes.headers["content-type"]?.includes("image/png") === true, "Header Content-Type é image/png");

  // 13. Testando Geração de Imagem QR Code SVG
  console.log("\n13. Testando Geração de Imagem SVG do QR Code...");
  const qrSvgRes = await request(`/api/links/${testSlug}/qr.svg`);
  assert(qrSvgRes.status === 200, "Endpoint de QR SVG responde 200");
  assert(qrSvgRes.headers["content-type"]?.includes("image/svg") === true, "Header Content-Type é image/svg+xml");

  // 14. Testando Exclusão do Link
  console.log("\n14. Testando Exclusão do Link...");
  const deleteRes = await request(`/api/links/${testSlug}`, {
    method: "DELETE",
  });
  assert(deleteRes.status === 200, "Link excluído com sucesso");

  // 15. Verificando que o Link Deletado Retorna 404
  console.log("\n15. Verificando Estado Após Exclusão...");
  const getDeleted = await request(`/api/links/${testSlug}`);
  assert(getDeleted.status === 404, "Link deletado retorna 404 Not Found");

  const redirDeleted = await request(`/q/${testSlug}`);
  assert(redirDeleted.status === 404, "Tentativa de redirecionar para link deletado exibe página 404 amigável");

  console.log("\n=======================================================");
  console.log(`  RESULTADO FINAL DOS TESTES: ${passed} PASSOU | ${failed} FALHOU`);
  console.log("=======================================================\n");

  if (failed > 0) {
    process.exit(1);
  }
}

runAllTests().catch((err) => {
  console.error("Erro inesperado durante a execução dos testes:", err);
  process.exit(1);
});
