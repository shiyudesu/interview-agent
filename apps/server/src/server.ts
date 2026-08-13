import { type TypeBoxTypeProvider, TypeBoxValidatorCompiler } from "@fastify/type-provider-typebox";
import Fastify, { type FastifyServerOptions } from "fastify";

export function createServer(options: FastifyServerOptions = {}) {
  return Fastify(options)
    .withTypeProvider<TypeBoxTypeProvider>()
    .setValidatorCompiler(TypeBoxValidatorCompiler);
}
