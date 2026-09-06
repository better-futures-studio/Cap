import {
	McpServer,
	ResourceTemplate,
} from "@modelcontextprotocol/sdk/server/mcp.js";
import { WebStandardStreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js";
import { z } from "zod";
import webPackage from "../package.json";
import type { McpPrincipal } from "./mcp-auth";
import { principalHasScope } from "./mcp-auth";
import {
	askRecording,
	getMeeting,
	getTranscript,
	listActionItems,
	listUpcomingMeetings,
	searchMeetings,
	searchRecordings,
} from "./mcp-tools";

const jsonResult = (value: unknown) => ({
	content: [{ type: "text" as const, text: JSON.stringify(value) }],
});

const errorResult = (message: string) => ({
	content: [
		{ type: "text" as const, text: JSON.stringify({ error: message }) },
	],
	isError: true as const,
});

function requireScope(
	principal: McpPrincipal,
	scope: "meetings:read" | "caps:read",
) {
	if (principalHasScope(principal, scope)) return null;
	return errorResult(`The ${scope} scope is required`);
}

export function createCapMcpServer(principal: McpPrincipal) {
	const server = new McpServer({
		name: "Cap",
		version: webPackage.version,
	});

	server.registerTool(
		"search_meetings",
		{
			description:
				"Search meetings the user can access by title, summary, attendees, speakers, or action items.",
			inputSchema: {
				query: z.string().optional().describe("Case-insensitive search text"),
				from: z.string().optional().describe("ISO date lower bound"),
				to: z.string().optional().describe("ISO date upper bound"),
				attendee: z
					.string()
					.optional()
					.describe("Filter by attendee name or email"),
				limit: z.number().int().optional().describe("Max results, default 20"),
			},
		},
		async (args) => {
			const denied = requireScope(principal, "meetings:read");
			if (denied) return denied;
			const results = await searchMeetings(principal, {
				...args,
				meetingsOnly: true,
			});
			return jsonResult(results);
		},
	);

	server.registerTool(
		"get_meeting",
		{
			description:
				"Get a meeting's full summary, chapters, action items, speakers, attendees, and notetaker Q&A.",
			inputSchema: {
				id: z.string().describe("Video or meeting recording id"),
			},
		},
		async ({ id }) => {
			const denied = requireScope(principal, "meetings:read");
			if (denied) return denied;
			const meeting = await getMeeting(principal, id);
			if (!meeting) return errorResult("Meeting not found");
			return jsonResult(meeting);
		},
	);

	server.registerTool(
		"get_transcript",
		{
			description:
				"Get a recording transcript with speaker names. Optionally trim to a time range.",
			inputSchema: {
				id: z.string().describe("Recording id"),
				startSeconds: z.number().optional().describe("Inclusive start time"),
				endSeconds: z.number().optional().describe("Inclusive end time"),
				format: z.enum(["text", "vtt"]).optional().describe("text or vtt"),
			},
		},
		async (args) => {
			if (
				!principalHasScope(principal, "meetings:read") &&
				!principalHasScope(principal, "caps:read")
			) {
				return errorResult("The meetings:read or caps:read scope is required");
			}
			const transcript = await getTranscript(principal, args);
			if (!transcript) return errorResult("Recording not found");
			return jsonResult(transcript);
		},
	);

	server.registerTool(
		"ask_recording",
		{
			description:
				"Ask a question about a recording using its transcript, summary, and action items.",
			inputSchema: {
				id: z.string().describe("Recording id"),
				question: z.string().describe("Question to answer from the recording"),
			},
		},
		async ({ id, question }) => {
			if (
				!principalHasScope(principal, "meetings:read") &&
				!principalHasScope(principal, "caps:read")
			) {
				return errorResult("The meetings:read or caps:read scope is required");
			}
			try {
				const result = await askRecording(principal, { id, question });
				if (!result) return errorResult("Recording not found");
				return jsonResult(result);
			} catch (error) {
				return errorResult(
					error instanceof Error ? error.message : "Ask failed",
				);
			}
		},
	);

	server.registerTool(
		"list_upcoming_meetings",
		{
			description:
				"List upcoming scheduled meeting bots the user owns or is invited to.",
			inputSchema: {
				days: z.number().int().optional().describe("Days ahead, default 7"),
			},
		},
		async ({ days }) => {
			const denied = requireScope(principal, "meetings:read");
			if (denied) return denied;
			return jsonResult(await listUpcomingMeetings(principal, days));
		},
	);

	server.registerTool(
		"search_recordings",
		{
			description: "Search screen recordings and meetings by title or summary.",
			inputSchema: {
				query: z.string().describe("Case-insensitive search text"),
				limit: z.number().int().optional().describe("Max results, default 20"),
			},
		},
		async ({ query, limit }) => {
			if (
				!principalHasScope(principal, "caps:read") &&
				!principalHasScope(principal, "meetings:read")
			) {
				return errorResult("The caps:read or meetings:read scope is required");
			}
			return jsonResult(await searchRecordings(principal, { query, limit }));
		},
	);

	server.registerTool(
		"list_action_items",
		{
			description:
				"List action items across meetings the user can access, with meeting title and link.",
			inputSchema: {
				from: z.string().optional().describe("ISO date lower bound"),
				to: z.string().optional().describe("ISO date upper bound"),
				owner: z.string().optional().describe("Filter by action-item owner"),
				limit: z.number().int().optional().describe("Max results, default 20"),
			},
		},
		async (args) => {
			const denied = requireScope(principal, "meetings:read");
			if (denied) return denied;
			return jsonResult(await listActionItems(principal, args));
		},
	);

	server.registerResource(
		"meeting",
		new ResourceTemplate("cap://meeting/{id}", { list: undefined }),
		{
			description: "Meeting summary, chapters, action items, and attendees",
			mimeType: "application/json",
		},
		async (uri, { id }) => {
			const meetingId = Array.isArray(id) ? id[0] : id;
			if (!meetingId) {
				return {
					contents: [{ uri: uri.href, text: '{"error":"Missing id"}' }],
				};
			}
			const meeting = await getMeeting(principal, meetingId);
			return {
				contents: [
					{
						uri: uri.href,
						mimeType: "application/json",
						text: JSON.stringify(meeting ?? { error: "Meeting not found" }),
					},
				],
			};
		},
	);

	return server;
}

export async function handleMcpRequest(
	request: Request,
	principal: McpPrincipal,
) {
	const server = createCapMcpServer(principal);
	const transport = new WebStandardStreamableHTTPServerTransport({
		sessionIdGenerator: undefined,
		enableJsonResponse: true,
	});
	await server.connect(transport);
	try {
		return await transport.handleRequest(request);
	} finally {
		await server.close();
	}
}
