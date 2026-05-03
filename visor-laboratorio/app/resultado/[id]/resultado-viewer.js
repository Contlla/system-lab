"use client";

import { useState } from "react";

export default function ResultadoViewer({ id, pdfUrl }) {
  const [isLoading, setIsLoading] = useState(Boolean(pdfUrl));

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
          {!pdfUrl ? (
            <div className="flex h-full min-h-[70vh] flex-col items-center justify-center px-6 text-center">
              <h2 className="text-xl font-semibold text-slate-950">
                Falta configurar la URL de R2
              </h2>
              <p className="mt-3 max-w-xl text-sm leading-6 text-slate-600">
                Define NEXT_PUBLIC_R2_URL en Vercel o en .env.local para que el
                visor pueda construir la direccion publica del PDF.
              </p>
            </div>
          ) : (
            <>
              {isLoading && (
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
                onLoad={() => setIsLoading(false)}
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
