import { randomUUID } from "node:crypto";
import { nanoId } from "@cap/database/helpers";
import * as Db from "@cap/database/schema";
import { type User, Video } from "@cap/web-domain";
import * as Dz from "drizzle-orm";
import type { MySqlInsertBase } from "drizzle-orm/mysql-core";
import { Array, Effect, Option } from "effect";
import type { Schema } from "effect/Schema";
import { Database } from "../Database.ts";

export type CreateVideoInput = Omit<
	Schema.Type<typeof Video.Video>,
	"id" | "createdAt" | "updatedAt"
> & { password?: string; importSource?: Video.ImportSource };

export class VideosRepo extends Effect.Service<VideosRepo>()("VideosRepo", {
	effect: Effect.gen(function* () {
		const db = yield* Database;

		/**
		 * Gets a `Video` and its accompanying password if available.
		 *
		 * The password is returned separately as the `Video` class is client-safe
		 */
		const getById = (id: Video.VideoId) =>
			Effect.gen(function* () {
				const [video] = yield* db.use((db) =>
					db.select().from(Db.videos).where(Dz.eq(Db.videos.id, id)),
				);

				return Option.fromNullable(video).pipe(
					Option.map(
						(v) =>
							[
								Video.Video.decodeSync({
									...v,
									bucketId: v.bucket,
									storageIntegrationId: v.storageIntegrationId,
									createdAt: v.createdAt.toISOString(),
									updatedAt: v.updatedAt.toISOString(),
									metadata: v.metadata as any,
								}),
								Option.fromNullable(video?.password),
							] as const,
					),
				);
			});

		const prepareDelete = (id: Video.VideoId, ownerId: User.UserId) =>
			db.use((database) =>
				database.transaction(async (tx) => {
					const now = new Date();
					const retired = {
						generation: randomUUID(),
						state: "source-blocked" as const,
						attemptId: null,
						leaseExpiresAt: null,
						nextRetryAt: now,
						workflowRunId: null,
						remoteJobId: null,
						errorCode: "video-deleting",
						errorMessage: "Recording deletion is in progress.",
						updatedAt: now,
					};
					await tx
						.insert(Db.videoProcessingJobs)
						.values({ videoId: id, ownerId, createdAt: now, ...retired })
						.onDuplicateKeyUpdate({ set: retired });
					const [video] = await tx
						.select({ ownerId: Db.videos.ownerId })
						.from(Db.videos)
						.where(Dz.eq(Db.videos.id, id))
						.for("update");
					if (!video || video.ownerId !== ownerId) {
						throw new Error("Video owner changed before deletion");
					}
				}),
			);

		const delete_ = (id: Video.VideoId, ownerId?: User.UserId) =>
			db.use(async (db) => {
				const unusedRecallBotIds: string[] = [];
				await db.transaction(async (db) => {
					const bots = await db
						.select({ recallBotId: Db.meetingBots.recallBotId })
						.from(Db.meetingBots)
						.where(Dz.eq(Db.meetingBots.videoId, id));
					const recallBotIds = [
						...new Set(
							bots
								.map((bot) => bot.recallBotId)
								.filter((botId): botId is string => Boolean(botId)),
						),
					];
					await db
						.delete(Db.videoProcessingJobs)
						.where(Dz.eq(Db.videoProcessingJobs.videoId, id));
					if (ownerId) {
						const [video] = await db
							.select({ ownerId: Db.videos.ownerId })
							.from(Db.videos)
							.where(Dz.eq(Db.videos.id, id))
							.for("update");
						if (!video || video.ownerId !== ownerId) {
							throw new Error("Video owner changed during deletion");
						}
					}
					await Promise.all([
						db.delete(Db.importedVideos).where(Dz.eq(Db.importedVideos.id, id)),
						db.delete(Db.videos).where(Dz.eq(Db.videos.id, id)),
						db
							.delete(Db.videoUploads)
							.where(Dz.eq(Db.videoUploads.videoId, id)),
						db.delete(Db.videoShares).where(Dz.eq(Db.videoShares.videoId, id)),
						db.delete(Db.meetingBots).where(Dz.eq(Db.meetingBots.videoId, id)),
					]);
					if (recallBotIds.length > 0) {
						const remaining = await db
							.select({ recallBotId: Db.meetingBots.recallBotId })
							.from(Db.meetingBots)
							.where(Dz.inArray(Db.meetingBots.recallBotId, recallBotIds));
						const stillUsed = new Set(
							remaining
								.map((row) => row.recallBotId)
								.filter((botId): botId is string => Boolean(botId)),
						);
						for (const recallBotId of recallBotIds) {
							if (!stillUsed.has(recallBotId)) {
								unusedRecallBotIds.push(recallBotId);
							}
						}
					}
				});
				return unusedRecallBotIds;
			});

		const create = (data: CreateVideoInput, options?: { id: Video.VideoId }) =>
			Effect.gen(function* () {
				const id = options?.id ?? Video.VideoId.make(nanoId());

				yield* db.use((db) =>
					db.transaction(async (db) => {
						const promises: MySqlInsertBase<any, any, any>[] = [
							db.insert(Db.videos).values([
								{
									...data,
									id,
									orgId: data.orgId,
									bucket: Option.getOrNull(data.bucketId ?? Option.none()),
									storageIntegrationId: Option.getOrNull(
										data.storageIntegrationId ?? Option.none(),
									),
									metadata: Option.getOrNull(data.metadata ?? Option.none()),
									transcriptionStatus: Option.getOrNull(
										data.transcriptionStatus ?? Option.none(),
									),
									folderId: Option.getOrNull(data.folderId ?? Option.none()),
									width: Option.getOrNull(data.width ?? Option.none()),
									height: Option.getOrNull(data.height ?? Option.none()),
									duration: Option.getOrNull(data.duration ?? Option.none()),
								},
							]),
						];

						if (data.importSource)
							promises.push(
								db.insert(Db.importedVideos).values([
									{
										id,
										orgId: data.orgId,
										source: data.importSource.source,
										sourceId: data.importSource.id,
									},
								]),
							);

						await Promise.all(promises);
					}),
				);

				return id;
			});

		const shareForVideo = (userId: User.UserId, videoId: Video.VideoId) =>
			db
				.use((db) =>
					db
						.select({ userId: Db.videoShares.userId })
						.from(Db.videoShares)
						.where(
							Dz.and(
								Dz.eq(Db.videoShares.userId, userId),
								Dz.eq(Db.videoShares.videoId, videoId),
							),
						)
						.limit(1),
				)
				.pipe(Effect.map(Array.get(0)));

		const listShares = (videoId: Video.VideoId) =>
			db.use((db) =>
				db
					.select({
						id: Db.users.id,
						name: Db.users.name,
						email: Db.users.email,
						source: Db.videoShares.source,
					})
					.from(Db.videoShares)
					.innerJoin(Db.users, Dz.eq(Db.videoShares.userId, Db.users.id))
					.where(Dz.eq(Db.videoShares.videoId, videoId)),
			);

		return {
			getById,
			prepareDelete,
			delete: delete_,
			create,
			shareForVideo,
			listShares,
		};
	}),
	dependencies: [Database.Default],
}) {}
