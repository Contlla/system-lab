import ResultadoViewer from "./resultado-viewer";

function buildPdfUrl(id) {
  const r2Url = (
    process.env.NEXT_PUBLIC_R2_URL ||
    "https://pub-0a2e3c7a919947f49c5ccb667d660d91.r2.dev"
  ).replace(/\/+$/, "");
  const objectTemplate =
    process.env.NEXT_PUBLIC_R2_OBJECT_TEMPLATE || "resultado-{id}.pdf";

  if (!r2Url) {
    return null;
  }

  const objectKey = objectTemplate.replace("{id}", encodeURIComponent(id));
  return `${r2Url}/${objectKey.replace(/^\/+/, "")}`;
}

export async function generateMetadata({ params }) {
  const { id } = await params;

  return {
    title: `Resultado ${id}`,
    description: "Consulta digital de resultados de laboratorio",
  };
}

export default async function VisorResultado({ params }) {
  const { id } = await params;
  const pdfUrl = buildPdfUrl(id);

  return <ResultadoViewer id={id} pdfUrl={pdfUrl} />;
}
