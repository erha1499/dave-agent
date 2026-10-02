-- The official image initially grants MYSQL_USER all privileges on MYSQL_DATABASE.
-- Narrow those actual grants after schema/seed initialization; prompt text is not authorization.
-- Its database grant escapes '_' as a pattern character; revoke by account to avoid a mismatched grant name.
REVOKE ALL PRIVILEGES, GRANT OPTION FROM 'dave_agent_read'@'%';
GRANT SELECT ON `dave\_agent`.* TO 'dave_agent_read'@'%';
