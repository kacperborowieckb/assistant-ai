CREATE VIRTUAL TABLE `notes_fts` USING fts5(`note_id` UNINDEXED, `text`, `url`);
--> statement-breakpoint
INSERT INTO `notes_fts` (`note_id`, `text`, `url`) SELECT `note_id`, `text`, coalesce(`url`, '') FROM `notes`;
--> statement-breakpoint
CREATE TRIGGER `notes_fts_insert`
AFTER INSERT ON `notes`
BEGIN
  INSERT INTO `notes_fts` (`note_id`, `text`, `url`) VALUES (NEW.`note_id`, NEW.`text`, coalesce(NEW.`url`, ''));
END;
--> statement-breakpoint
CREATE TRIGGER `notes_fts_update`
AFTER UPDATE OF `text`, `url` ON `notes`
BEGIN
  DELETE FROM `notes_fts` WHERE `note_id` = OLD.`note_id`;
  INSERT INTO `notes_fts` (`note_id`, `text`, `url`) VALUES (NEW.`note_id`, NEW.`text`, coalesce(NEW.`url`, ''));
END;
--> statement-breakpoint
CREATE TRIGGER `notes_fts_delete`
AFTER DELETE ON `notes`
BEGIN
  DELETE FROM `notes_fts` WHERE `note_id` = OLD.`note_id`;
END;
