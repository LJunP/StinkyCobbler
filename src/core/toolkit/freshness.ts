export interface KnowledgeToolResponse {
  serverId: string;
  tool: string;
  fresh: boolean;
}

export interface KnowledgeFreshness {
  serverId: string;
  status: "fresh" | "stale" | "unavailable";
  tool?: string;
}

export function knowledgeFreshness(
  servers: readonly { id: string; role?: "knowledge" | undefined }[],
  responses: readonly KnowledgeToolResponse[]
): KnowledgeFreshness[] {
  const reports: KnowledgeFreshness[] = [];
  for (const server of servers) {
    if (server.role !== "knowledge") continue;
    const response = responses.find((item) => item.serverId === server.id);
    reports.push(response === undefined ? unavailable(server.id) : reported(server.id, response));
  }
  return reports;
}

function unavailable(serverId: string): KnowledgeFreshness {
  return { serverId, status: "unavailable" };
}

function reported(serverId: string, response: KnowledgeToolResponse): KnowledgeFreshness {
  return { serverId, status: response.fresh ? "fresh" : "stale", tool: response.tool };
}
