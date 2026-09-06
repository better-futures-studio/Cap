CREATE TABLE `oauth_authorization_requests` (
	`id` varchar(15) NOT NULL,
	`clientId` varchar(15) NOT NULL,
	`userId` varchar(15),
	`redirectUri` varchar(2048) NOT NULL,
	`scope` varchar(1024),
	`state` varchar(256),
	`codeChallenge` varchar(128) NOT NULL,
	`resource` varchar(2048),
	`status` varchar(16) NOT NULL DEFAULT 'pending',
	`expiresAt` timestamp NOT NULL,
	`createdAt` timestamp NOT NULL DEFAULT (now()),
	CONSTRAINT `oauth_authorization_requests_id` PRIMARY KEY(`id`)
);
--> statement-breakpoint
CREATE TABLE `oauth_clients` (
	`id` varchar(15) NOT NULL,
	`clientSecretHash` varchar(64),
	`name` varchar(255) NOT NULL,
	`clientUri` varchar(2048),
	`logoUri` varchar(2048),
	`redirectUris` json NOT NULL,
	`tokenEndpointAuthMethod` varchar(32) NOT NULL DEFAULT 'none',
	`createdAt` timestamp NOT NULL DEFAULT (now()),
	`lastUsedAt` timestamp,
	CONSTRAINT `oauth_clients_id` PRIMARY KEY(`id`)
);
--> statement-breakpoint
CREATE TABLE `oauth_refresh_tokens` (
	`id` varchar(15) NOT NULL,
	`tokenHash` varchar(64) NOT NULL,
	`accessTokenId` varchar(15) NOT NULL,
	`clientId` varchar(15) NOT NULL,
	`userId` varchar(15) NOT NULL,
	`scopes` json NOT NULL,
	`expiresAt` timestamp NOT NULL,
	`revokedAt` timestamp,
	`createdAt` timestamp NOT NULL DEFAULT (now()),
	CONSTRAINT `oauth_refresh_tokens_id` PRIMARY KEY(`id`),
	CONSTRAINT `oauth_refresh_token_hash_idx` UNIQUE(`tokenHash`)
);
--> statement-breakpoint
CREATE TABLE `video_search` (
	`videoId` varchar(15) NOT NULL,
	`orgId` varchar(15) NOT NULL,
	`ownerId` varchar(15) NOT NULL,
	`title` varchar(255) NOT NULL,
	`summary` text,
	`transcriptText` mediumtext,
	`participants` text,
	`updatedAt` timestamp NOT NULL DEFAULT (now()) ON UPDATE CURRENT_TIMESTAMP,
	CONSTRAINT `video_search_videoId` PRIMARY KEY(`videoId`)
);
--> statement-breakpoint
ALTER TABLE `agent_api_authorization_codes` ADD `clientId` varchar(64);--> statement-breakpoint
ALTER TABLE `agent_api_keys` ADD `oauthClientId` varchar(15);--> statement-breakpoint
CREATE INDEX `oauth_authz_requests_client_id_idx` ON `oauth_authorization_requests` (`clientId`);--> statement-breakpoint
CREATE INDEX `oauth_authz_requests_expires_at_idx` ON `oauth_authorization_requests` (`expiresAt`);--> statement-breakpoint
CREATE INDEX `oauth_clients_created_at_idx` ON `oauth_clients` (`createdAt`);--> statement-breakpoint
CREATE INDEX `oauth_refresh_access_token_id_idx` ON `oauth_refresh_tokens` (`accessTokenId`);--> statement-breakpoint
CREATE INDEX `oauth_refresh_expires_at_idx` ON `oauth_refresh_tokens` (`expiresAt`);--> statement-breakpoint
CREATE INDEX `video_search_org_id_idx` ON `video_search` (`orgId`);--> statement-breakpoint
CREATE INDEX `video_search_owner_id_idx` ON `video_search` (`ownerId`);--> statement-breakpoint
CREATE INDEX `client_id_idx` ON `agent_api_authorization_codes` (`clientId`);--> statement-breakpoint
CREATE INDEX `oauth_client_id_idx` ON `agent_api_keys` (`oauthClientId`);--> statement-breakpoint
CREATE FULLTEXT INDEX `video_search_fulltext_idx` ON `video_search` (`title`, `summary`, `transcriptText`, `participants`);