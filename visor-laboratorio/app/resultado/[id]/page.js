import ResultadoViewer from "./resultado-viewer";

export async function generateMetadata({ params }) {
  const { id } = await params;

  return {
    title: `Resultado ${id}`,
    description: "Consulta digital de resultados de laboratorio",
    robots: {
      index: false,
      follow: false,
      nocache: true,
    },
  };
}

export default async function VisorResultado({ params }) {
  const { id } = await params;

  return <ResultadoViewer id={id} />;
}
