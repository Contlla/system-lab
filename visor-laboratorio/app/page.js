import Link from "next/link";

export default function Home() {
  return (
    <main className="min-h-screen bg-slate-100 px-4 py-10 text-slate-900">
      <section className="mx-auto flex min-h-[70vh] w-full max-w-3xl flex-col justify-center">
        <p className="text-sm font-semibold uppercase tracking-[0.18em] text-blue-700">
          Laboratorio Clinico
        </p>
        <h1 className="mt-4 text-4xl font-bold tracking-tight text-slate-950">
          Visor digital de resultados
        </h1>
        <p className="mt-4 max-w-2xl text-base leading-7 text-slate-600">
          Abre un resultado usando una ruta con identificador, por ejemplo
          <span className="mx-1 font-mono text-sm text-slate-900">
            /resultado/uuid-del-pdf
          </span>
          . Los codigos QR generados por el backend deben apuntar a esa ruta.
        </p>
        <div className="mt-8">
          <Link
            href="/resultado/00000000-0000-4000-8000-000000000000"
            className="inline-flex h-11 items-center rounded-md bg-blue-700 px-5 text-sm font-semibold text-white transition hover:bg-blue-800"
          >
            Ver ruta de ejemplo
          </Link>
        </div>
      </section>
    </main>
  );
}
