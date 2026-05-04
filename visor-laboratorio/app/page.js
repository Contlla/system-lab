import Link from "next/link";
import Image from "next/image";

export default function Home() {
  return (
    <main className="min-h-screen bg-[#f3faf5] px-4 py-10 text-[#15364a]">
      <section className="mx-auto flex min-h-[70vh] w-full max-w-3xl flex-col justify-center">
        <Image
          src="/vica-logo.svg"
          alt="VICA Laboratorio"
          width={260}
          height={79}
          className="h-24 w-fit"
          priority
        />
        <h1 className="mt-6 text-4xl font-bold tracking-tight text-[#15364a]">
          Visor digital de resultados
        </h1>
        <p className="mt-4 max-w-2xl text-base leading-7 text-[#4f6673]">
          Abre un resultado usando una ruta con identificador, por ejemplo
          <span className="mx-1 font-mono text-sm text-[#15364a]">
            /resultado/uuid-del-pdf
          </span>
          . Los codigos QR generados por el backend deben apuntar a esa ruta.
        </p>
        <p className="mt-4 text-sm font-semibold text-[#1598cf]">
          Atencion a pacientes: +52 1 55 7465 8297
        </p>
        <div className="mt-8">
          <Link
            href="/resultado/00000000-0000-4000-8000-000000000000"
            className="inline-flex h-11 items-center rounded-md bg-[#1598cf] px-5 text-sm font-semibold text-white transition hover:bg-[#0f7eaa]"
          >
            Ver ruta de ejemplo
          </Link>
        </div>
        <p className="mt-8 max-w-2xl text-xs leading-5 text-[#5f747d]">
          Aviso de confidencialidad: Los resultados contienen informacion de
          salud y deben ser consultados solo por el paciente, medico tratante o
          personal autorizado.
        </p>
      </section>
    </main>
  );
}
