const DEFAULT_OBJECT_TEMPLATE = "resultado-{id}.pdf";
const RESULT_ID_RE = /^[A-Za-z0-9][A-Za-z0-9_-]{7,79}$/;

function getR2BaseUrl() {
  return process.env.NEXT_PUBLIC_R2_URL?.replace(/\/+$/, "") || "";
}

function getObjectTemplate() {
  return process.env.NEXT_PUBLIC_R2_OBJECT_TEMPLATE || DEFAULT_OBJECT_TEMPLATE;
}

function buildPdfUrl(id) {
  const r2Url = getR2BaseUrl();
  if (!r2Url) return null;

  const objectKey = getObjectTemplate().replace("{id}", encodeURIComponent(id));
  return `${r2Url}/${objectKey.replace(/^\/+/, "")}`;
}

function json(body, init = {}) {
  return Response.json(body, {
    ...init,
    headers: {
      "Cache-Control": "no-store",
      "X-Content-Type-Options": "nosniff",
      ...(init.headers || {}),
    },
  });
}

export async function GET(_request, { params }) {
  const { id } = await params;

  if (!RESULT_ID_RE.test(String(id || ""))) {
    return json({ exists: false, error: "ID de resultado invalido" }, { status: 400 });
  }

  const pdfUrl = buildPdfUrl(id);
  if (!pdfUrl) {
    return json(
      { exists: false, error: "NEXT_PUBLIC_R2_URL no esta configurada" },
      { status: 503 }
    );
  }

  try {
    const response = await fetch(pdfUrl, {
      method: "HEAD",
      cache: "no-store",
    });

    if (response.status === 404) {
      return json({ exists: false, error: "Resultado no encontrado" }, { status: 404 });
    }

    if (!response.ok) {
      return json(
        { exists: false, error: "Resultado no disponible temporalmente" },
        { status: 502 }
      );
    }

    const contentType = response.headers.get("content-type") || "";
    if (contentType && !contentType.toLowerCase().includes("application/pdf")) {
      return json(
        { exists: false, error: "El archivo encontrado no es un PDF valido" },
        { status: 415 }
      );
    }

    return json({
      exists: true,
      id,
      pdfUrl,
      contentLength: response.headers.get("content-length"),
      contentType: contentType || "application/pdf",
    });
  } catch {
    return json(
      { exists: false, error: "No se pudo contactar el almacenamiento de resultados" },
      { status: 502 }
    );
  }
}
