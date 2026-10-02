-- Evaluation history shares the business database; these tables contain synthetic test inputs only.
SET NAMES utf8mb4;
USE dave_agent;

CREATE TABLE IF NOT EXISTS eval_runs (
  id CHAR(36) CHARACTER SET ascii COLLATE ascii_bin PRIMARY KEY,
  kind ENUM('model', 'engineering') NOT NULL,
  started_at DATETIME(3) NOT NULL,
  record JSON NOT NULL,
  KEY ix_eval_run_kind_time (kind, started_at)
);

CREATE TABLE IF NOT EXISTS eval_case_results (
  sequence_id BIGINT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
  run_id CHAR(36) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  case_id VARCHAR(64) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  record JSON NOT NULL,
  UNIQUE KEY uq_eval_case (run_id, case_id),
  CONSTRAINT fk_eval_case_run FOREIGN KEY (run_id) REFERENCES eval_runs(id)
);

CREATE TABLE IF NOT EXISTS eval_turn_results (
  run_id CHAR(36) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  case_id VARCHAR(64) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  turn_index INT UNSIGNED NOT NULL,
  record JSON NOT NULL,
  PRIMARY KEY (run_id, case_id, turn_index),
  CONSTRAINT fk_eval_turn_case FOREIGN KEY (run_id, case_id) REFERENCES eval_case_results(run_id, case_id)
);

CREATE TABLE IF NOT EXISTS eval_steps (
  run_id CHAR(36) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  case_id VARCHAR(64) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  turn_index INT UNSIGNED NOT NULL,
  step_index INT UNSIGNED NOT NULL,
  record JSON NOT NULL,
  PRIMARY KEY (run_id, case_id, turn_index, step_index),
  CONSTRAINT fk_eval_step_turn FOREIGN KEY (run_id, case_id, turn_index) REFERENCES eval_turn_results(run_id, case_id, turn_index)
);
