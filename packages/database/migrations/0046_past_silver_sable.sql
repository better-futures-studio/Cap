CREATE TABLE `meeting_calendar_series_rules` (
	`id` varchar(15) NOT NULL,
	`calendarId` varchar(15) NOT NULL,
	`seriesKey` varchar(255) NOT NULL,
	`record` boolean NOT NULL,
	`title` varchar(255),
	`createdAt` timestamp NOT NULL DEFAULT (now()),
	`updatedAt` timestamp NOT NULL DEFAULT (now()) ON UPDATE CURRENT_TIMESTAMP,
	CONSTRAINT `meeting_calendar_series_rules_id` PRIMARY KEY(`id`),
	CONSTRAINT `meeting_calendar_series_rules_calendar_series_idx` UNIQUE(`calendarId`,`seriesKey`)
);
--> statement-breakpoint
CREATE TABLE `meeting_preferences` (
	`userId` varchar(15) NOT NULL,
	`orgId` varchar(15) NOT NULL,
	`recapMode` varchar(16) NOT NULL DEFAULT 'self',
	`createdAt` timestamp NOT NULL DEFAULT (now()),
	`updatedAt` timestamp NOT NULL DEFAULT (now()) ON UPDATE CURRENT_TIMESTAMP,
	CONSTRAINT `meeting_preferences_userId` PRIMARY KEY(`userId`)
);
--> statement-breakpoint
ALTER TABLE `meeting_bots` ADD `recapSentAt` timestamp;