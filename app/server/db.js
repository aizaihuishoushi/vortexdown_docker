/**
 * db.js - JSON file persistence layer for VortexDown (Docker Edition)
 * Uses DATA_DIR env var or fallback to ./data/
 * Pure ESM, zero dependencies
 */

import { readFileSync, writeFileSync, mkdirSync, existsSync } from 'node:fs';
import { join } from 'node:path';

const DATA_DIR = process.env.DATA_DIR
  ? process.env.DATA_DIR
  : join(process.cwd(), 'data');

const TASKS_FILE = join(DATA_DIR, 'tasks.json');
const SETTINGS_FILE = join(DATA_DIR, 'settings.json');

// Ensure data directory exists
if (!existsSync(DATA_DIR)) {
  mkdirSync(DATA_DIR, { recursive: true });
}

// 计算安全的默认下载目录
function getDefaultSaveDir() {
  if (process.env.DOWNLOAD_DIR) {
    return process.env.DOWNLOAD_DIR;
  }
  const fallback = '/downloads';
  try {
    mkdirSync(fallback, { recursive: true });
    return fallback;
  } catch {
    return join(process.cwd(), 'downloads');
  }
}

// Default settings
const DEFAULT_SETTINGS = {
  saveDir: getDefaultSaveDir(),
  maxConcurrent: 3,
  m3u8Concurrency: 8,
  namingTemplate: '{name} S{season}E{episode}.{ext}',
};

/**
 * Read a JSON file, return parsed object or null
 */
function readJsonFile(filePath) {
  try {
    if (!existsSync(filePath)) return null;
    const raw = readFileSync(filePath, 'utf-8');
    return JSON.parse(raw);
  } catch (err) {
    console.error(`[db] Error reading ${filePath}:`, err.message);
    return null;
  }
}

/**
 * Write an object to a JSON file
 */
function writeJsonFile(filePath, data) {
  try {
    writeFileSync(filePath, JSON.stringify(data, null, 2), 'utf-8');
    return true;
  } catch (err) {
    console.error(`[db] Error writing ${filePath}:`, err.message);
    return false;
  }
}

// ---- Tasks CRUD ----

/**
 * Load all tasks from disk
 */
export function loadTasks() {
  const tasks = readJsonFile(TASKS_FILE);
  return tasks || [];
}

/**
 * Save all tasks to disk
 */
export function saveTasks(tasks) {
  return writeJsonFile(TASKS_FILE, tasks);
}

/**
 * Get a task by id
 */
export function getTask(id) {
  const tasks = loadTasks();
  return tasks.find(t => t.id === id) || null;
}

/**
 * Add a new task
 */
export function addTask(task) {
  const tasks = loadTasks();
  tasks.push(task);
  saveTasks(tasks);
  return task;
}

/**
 * Add multiple tasks at once
 */
export function addTasks(taskList) {
  const tasks = loadTasks();
  tasks.push(...taskList);
  saveTasks(tasks);
  return taskList;
}

/**
 * Update a task by id
 */
export function updateTask(id, updates) {
  const tasks = loadTasks();
  const idx = tasks.findIndex(t => t.id === id);
  if (idx === -1) return null;
  Object.assign(tasks[idx], updates);
  saveTasks(tasks);
  return tasks[idx];
}

/**
 * Delete a task by id
 */
export function deleteTask(id) {
  const tasks = loadTasks();
  const idx = tasks.findIndex(t => t.id === id);
  if (idx === -1) return false;
  tasks.splice(idx, 1);
  saveTasks(tasks);
  return true;
}

// ---- Settings CRUD ----

/**
 * Load settings from disk
 */
export function loadSettings() {
  const settings = readJsonFile(SETTINGS_FILE);
  return settings || { ...DEFAULT_SETTINGS };
}

/**
 * Save settings to disk
 */
export function saveSettings(settings) {
  return writeJsonFile(SETTINGS_FILE, settings);
}

/**
 * Get a single setting value
 */
export function getSetting(key) {
  const settings = loadSettings();
  return settings[key] !== undefined ? settings[key] : DEFAULT_SETTINGS[key];
}

/**
 * Update settings (partial update supported)
 */
export function updateSettings(updates) {
  const settings = loadSettings();
  Object.assign(settings, updates);
  saveSettings(settings);
  return settings;
}
