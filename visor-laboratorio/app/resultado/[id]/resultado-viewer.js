"use client";

import { useEffect, useState } from "react";

export default function ResultadoViewer({ id }) {
  const [status, setStatus] = useState("checking");
  const [pdfUrl, setPdfUrl] = useState("");
  const [error, setError] = useState("");

  useEffect(() => {
    const controller = new AbortController();
    let timeoutId = window.setTimeout(() => controller.abort(), 12000);

    async function verifyResult() {
      setStatus("checking");
      setError("");
      setPdfUrl("");

      try {
        const response = await fetch(`/api/resultado/${encodeURIComponent(id)}`, {
          cache: "no-store",
          signal: controller.signal,
        });
        const data = await response.json().catch(() => ({}));

        if (!response.ok || !data.exists || !data.pdfUrl) {
          setError(data.error || "Resultado no disponible");
          setStatus(response.status === 404 ? "not_found" : "error");
          return;
        }

        setPdfUrl(data.pdfUrl);
        setStatus("loading_pdf");
      } catch (verifyError) {
        setError(
          verifyError.name === "AbortError"
            ? "El almacenamiento tardo demasiado en responder"
            : "No se pudo verificar el resultado"
        );
        setStatus("error");
      } finally {
        window.clearTimeout(timeoutId);
      }
    }

    verifyResult();

    return () => {
      window.clearTimeout(timeoutId);
      controller.abort();
    };
  }, [id]);

  const isBusy = status === "checking" || status === "loading_pdf";

  return (
    <div className="min-h-screen bg-slate-100 px-4 py-6 text-slate-900">
      <div className="mx-auto flex min-h-[calc(100vh-3rem)] w-full max-w-5xl flex-col">
        <header className="mb-5 flex flex-col gap-4 rounded-lg border border-slate-200 bg-white p-5 shadow-sm sm:flex-row sm:items-center sm:justify-between">
          <div>
            <h1 className="text-2xl font-bold text-blue-700">
              Laboratorio Clinico
            </h1>
            <p className="mt-1 text-sm text-slate-500">
              Consulta de Resultados Digitales
            </p>
          </div>

          <button
            type="button"
            onClick={() => window.print()}
            className="inline-flex h-11 items-center justify-center rounded-md bg-blue-700 px-4 text-sm font-semibold text-white transition hover:bg-blue-800 focus:outline-none focus:ring-2 focus:ring-blue-500 focus:ring-offset-2"
          >
            Imprimir / Descargar
          </button>
        </header>

        <main className="relative min-h-[70vh] flex-1 overflow-hidden rounded-lg border border-slate-200 bg-white shadow-sm">
          {status === "checking" ? (
            <div className="flex h-full min-h-[70vh] flex-col items-center justify-center px-6 text-center">
              <h2 className="text-xl font-semibold text-slate-950">
                Verificando resultado
              </h2>
              <p className="mt-3 max-w-xl text-sm leading-6 text-slate-600">
                Estamos confirmando que el PDF digital este disponible.
              </p>
            </div>
          ) : status === "not_found" ? (
            <div className="flex h-full min-h-[70vh] flex-col items-center justify-center px-6 text-center">
              <h2 className="text-xl font-semibold text-slate-950">
                Resultado no encontrado
              </h2>
              <p className="mt-3 max-w-xl text-sm leading-6 text-slate-600">
                El resultado puede estar pendiente de carga o el codigo de
                verificacion no corresponde a un archivo disponible.
              </p>
              <p className="mt-4 text-xs font-semibold text-slate-500">
                ID: <span className="font-mono">{id}</span>
              </p>
            </div>
          ) : status === "error" ? (
            <div className="flex h-full min-h-[70vh] flex-col items-center justify-center px-6 text-center">
              <h2 className="text-xl font-semibold text-slate-950">
                No se pudo abrir el resultado
              </h2>
              <p className="mt-3 max-w-xl text-sm leading-6 text-slate-600">
                {error || "Intentalo de nuevo mas tarde o contacta al laboratorio."}
              </p>
            </div>
          ) : (
            <>
              {isBusy && (
                <div className="absolute inset-0 z-10 flex items-center justify-center bg-white">
                  <p className="text-sm font-medium text-slate-500">
                    Cargando resultado...
                  </p>
                </div>
              )}
              <iframe
                src={`${pdfUrl}#toolbar=0`}
                className="h-full min-h-[70vh] w-full"
                title="Resultado del Estudio"
                onLoad={() => setStatus("ready")}
              />
            </>
          )}
        </main>

        <footer className="mt-5 text-center text-xs text-slate-500">
          ID de Verificacion: <span className="font-mono">{id}</span> | Este
          documento es una copia digital fiel del original.
          {pdfUrl && (
            <span className="block pt-2">
              <a
                href={pdfUrl}
                target="_blank"
                rel="noreferrer"
                className="font-medium text-blue-700 hover:text-blue-800"
              >
                Abrir PDF en una pestana nueva
              </a>
            </span>
          )}
        </footer>
      </div>
    </div>
  );
}
