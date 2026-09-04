ALTER TABLE `users` ADD `systemKind` varchar(16);--> statement-breakpoint
ALTER TABLE `users` ADD `systemOrganizationId` varchar(15);--> statement-breakpoint
ALTER TABLE `users` ADD `disabledAt` timestamp;