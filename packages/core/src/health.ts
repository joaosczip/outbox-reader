export function startHealthServer(port?: number): ReturnType<typeof Bun.serve> {
	const resolvedPort = port ?? Number(process.env.PORT ?? "4599");

	return Bun.serve({
		port: resolvedPort,
		fetch(req) {
			const url = new URL(req.url);
			if (req.method === "GET" && url.pathname === "/health") {
				return Response.json({ status: "ok" });
			}
			return new Response(null, { status: 404 });
		},
	});
}
