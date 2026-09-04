CREATE TABLE `video_shares` (
	`videoId` varchar(15) NOT NULL,
	`userId` varchar(15) NOT NULL,
	`sharedByUserId` varchar(15) NOT NULL,
	`source` varchar(16) NOT NULL,
	`createdAt` timestamp NOT NULL DEFAULT (now()),
	CONSTRAINT `video_shares_videoId_userId_pk` PRIMARY KEY(`videoId`,`userId`)
);
--> statement-breakpoint
CREATE INDEX `video_shares_user_id_idx` ON `video_shares` (`userId`);