CREATE TABLE `slack_huddle_teams` (
	`id` varchar(15) NOT NULL,
	`orgId` varchar(15) NOT NULL,
	`recallSlackTeamId` varchar(64) NOT NULL,
	`botName` varchar(255) NOT NULL,
	`status` varchar(32) NOT NULL,
	`workspaceName` varchar(255),
	`createdAt` timestamp NOT NULL DEFAULT (now()),
	`updatedAt` timestamp NOT NULL DEFAULT (now()) ON UPDATE CURRENT_TIMESTAMP,
	CONSTRAINT `slack_huddle_teams_id` PRIMARY KEY(`id`),
	CONSTRAINT `slack_huddle_teams_recall_slack_team_id_idx` UNIQUE(`recallSlackTeamId`)
);
--> statement-breakpoint
ALTER TABLE `meeting_bots` ADD `slackTeamId` varchar(64);--> statement-breakpoint
ALTER TABLE `meeting_bots` ADD `slackChannelId` varchar(64);