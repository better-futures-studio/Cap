CREATE TABLE `meeting_bots` (
	`id` varchar(15) NOT NULL,
	`orgId` varchar(15) NOT NULL,
	`ownerId` varchar(15) NOT NULL,
	`source` varchar(16) NOT NULL,
	`meetingUrl` varchar(2048) NOT NULL,
	`title` varchar(255),
	`joinAt` timestamp NOT NULL,
	`endAt` timestamp,
	`calendarId` varchar(15),
	`calendarEventId` varchar(64),
	`recallBotId` varchar(64),
	`recallRecordingId` varchar(64),
	`recallTranscriptId` varchar(64),
	`status` varchar(32) NOT NULL,
	`statusSubCode` varchar(128),
	`errorMessage` text,
	`videoId` varchar(15),
	`createdAt` timestamp NOT NULL DEFAULT (now()),
	`updatedAt` timestamp NOT NULL DEFAULT (now()) ON UPDATE CURRENT_TIMESTAMP,
	CONSTRAINT `meeting_bots_id` PRIMARY KEY(`id`),
	CONSTRAINT `meeting_bots_calendar_event_id_idx` UNIQUE(`calendarEventId`)
);
--> statement-breakpoint
CREATE TABLE `meeting_calendars` (
	`id` varchar(15) NOT NULL,
	`orgId` varchar(15) NOT NULL,
	`userId` varchar(15) NOT NULL,
	`recallCalendarId` varchar(64) NOT NULL,
	`platform` varchar(32) NOT NULL,
	`platformEmail` varchar(255),
	`status` varchar(32) NOT NULL,
	`autoRecord` boolean NOT NULL DEFAULT false,
	`lastSyncedAt` timestamp,
	`createdAt` timestamp NOT NULL DEFAULT (now()),
	`updatedAt` timestamp NOT NULL DEFAULT (now()) ON UPDATE CURRENT_TIMESTAMP,
	CONSTRAINT `meeting_calendars_id` PRIMARY KEY(`id`),
	CONSTRAINT `meeting_calendars_recall_calendar_id_idx` UNIQUE(`recallCalendarId`)
);
--> statement-breakpoint
CREATE TABLE `recall_webhook_events` (
	`id` varchar(64) NOT NULL,
	`event` varchar(64) NOT NULL,
	`receivedAt` timestamp NOT NULL DEFAULT (now()),
	CONSTRAINT `recall_webhook_events_id` PRIMARY KEY(`id`)
);
--> statement-breakpoint
CREATE INDEX `meeting_bots_org_created_at_idx` ON `meeting_bots` (`orgId`,`createdAt`);--> statement-breakpoint
CREATE INDEX `meeting_bots_recall_bot_id_idx` ON `meeting_bots` (`recallBotId`);--> statement-breakpoint
CREATE INDEX `meeting_bots_video_id_idx` ON `meeting_bots` (`videoId`);--> statement-breakpoint
CREATE INDEX `meeting_calendars_org_user_idx` ON `meeting_calendars` (`orgId`,`userId`);