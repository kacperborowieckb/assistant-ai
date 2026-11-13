const handleRequest: ExportedHandlerFetchHandler<Env> = () =>
  new Response("Not Found", { status: 404 });

export const edge = {
  fetch: handleRequest,
} satisfies ExportedHandler<Env>;
