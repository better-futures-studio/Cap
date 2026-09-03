CREATE TABLE `meeting_vocabulary` (
	`id` varchar(15) NOT NULL,
	`orgId` varchar(15) NOT NULL,
	`term` varchar(255) NOT NULL,
	`spelling` varchar(255),
	`createdAt` timestamp NOT NULL DEFAULT (now()),
	CONSTRAINT `meeting_vocabulary_id` PRIMARY KEY(`id`),
	CONSTRAINT `meeting_vocabulary_org_term_idx` UNIQUE(`orgId`,`term`)
);
