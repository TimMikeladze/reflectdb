import { useState, useCallback, useMemo, useEffect, useRef } from "react";
import {
	SyncProvider,
	useSync,
	useSyncStatus,
	usePendingCount,
	useEphemeral,
	useRow,
	useSyncClient,
	useTotalCount,
	useLoadMore,
} from "../../src/react/index.ts";

// ── Types ────────────────────────────────────────────────────────────────────

interface Task {
	id: string;
	title: string;
	description?: string;
	status: string;
	priority: string;
	assignee?: string;
	projectId: string;
	createdBy: string;
	createdAt: string;
	updatedAt?: string;
	deletedAt?: string;
	position: number;
}

interface Project {
	id: string;
	name: string;
	color: string;
	createdBy: string;
}

interface Comment {
	id: string;
	taskId: string;
	text: string;
	authorId: string;
	createdAt: string;
}

// ── Helpers ──────────────────────────────────────────────────────────────────

const uid = () => crypto.randomUUID().slice(0, 8);

function getUser(): { token: string; userId: string; name: string } {
	const params = new URLSearchParams(window.location.search);
	const user = params.get("user") ?? "alice";
	if (user === "bob") return { token: "bob-token", userId: "bob", name: "Bob" };
	return { token: "alice-token", userId: "alice", name: "Alice" };
}

function timeAgo(iso: string): string {
	const s = Math.floor((Date.now() - new Date(iso).getTime()) / 1000);
	if (s < 60) return "just now";
	if (s < 3600) return `${Math.floor(s / 60)}m ago`;
	if (s < 86400) return `${Math.floor(s / 3600)}h ago`;
	return `${Math.floor(s / 86400)}d ago`;
}

const PRIORITY_COLORS: Record<string, string> = {
	high: "#ef4444",
	medium: "#f59e0b",
	low: "#6b7280",
};

const STATUS_LABELS: Record<string, string> = {
	todo: "To Do",
	in_progress: "In Progress",
	done: "Done",
};

// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
// CONNECTION STATUS — useSyncStatus
// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

function StatusBadge() {
	const status = useSyncStatus();
	const pending = usePendingCount();

	const label =
		status === "synced"
			? "Synced"
			: status === "connecting"
				? "Connecting..."
				: status === "bootstrapping"
					? "Loading..."
					: status === "disconnected"
						? "Offline"
						: status;

	return (
		<div className={`status-badge ${status}`}>
			<span className="status-dot" />
			{label}
			{pending > 0 && <span className="pending-badge">{pending}</span>}
		</div>
	);
}

// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
// PRESENCE — useEphemeral
// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

function PresenceBar({ userId }: { userId: string }) {
	const { events, broadcast } = useEphemeral<{ name: string; view: string }>({
		key: "presence",
		userId,
		ttlMs: 10000,
	});

	// Broadcast presence every 5s
	useEffect(() => {
		const user = getUser();
		broadcast({ name: user.name, view: "tasks" });
		const interval = setInterval(() => {
			broadcast({ name: user.name, view: "tasks" });
		}, 5000);
		return () => clearInterval(interval);
	}, [broadcast]);

	const others = Object.entries(events).filter(([uid]) => uid !== userId);

	if (others.length === 0) return null;

	return (
		<div className="presence-bar">
			{others.map(([uid, data]) => (
				<span key={uid} className="presence-avatar" title={data.name}>
					{data.name[0]}
				</span>
			))}
			<span className="presence-label">
				{others.length === 1 ? `${others[0]![1].name} is here` : `${others.length} others online`}
			</span>
		</div>
	);
}

// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
// TASK CARD — useRow (single row)
// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

function TaskCard({
	taskId,
	onSelect,
	isSelected,
}: {
	taskId: string;
	onSelect: (id: string) => void;
	isSelected: boolean;
}) {
	const task = useRow<Task>("tasks", taskId);
	const { update } = useSync<Task>("tasks");

	if (!task) return null;

	const cycleStatus = (e: React.MouseEvent) => {
		e.stopPropagation();
		const next: Record<string, string> = {
			todo: "in_progress",
			in_progress: "done",
			done: "todo",
		};
		update(task.id, { status: next[task.status] ?? "todo" });
	};

	return (
		<div className={`task-card ${isSelected ? "selected" : ""}`} onClick={() => onSelect(task.id)}>
			<div className="task-header">
				<button
					className={`status-toggle ${task.status}`}
					onClick={cycleStatus}
					title={`Status: ${STATUS_LABELS[task.status]}`}
				>
					{task.status === "done" ? "\u2713" : task.status === "in_progress" ? "\u25CB" : "\u25CB"}
				</button>
				<span className={`task-title ${task.status === "done" ? "done" : ""}`}>{task.title}</span>
				<span
					className="priority-dot"
					style={{ background: PRIORITY_COLORS[task.priority] }}
					title={task.priority}
				/>
			</div>
			{task.description && <div className="task-desc">{task.description}</div>}
			<div className="task-meta">
				{task.assignee && <span className="assignee">@{task.assignee}</span>}
				{task.createdAt && <span className="time">{timeAgo(task.createdAt)}</span>}
			</div>
		</div>
	);
}

// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
// TASK LIST — useSync with windowed sync, useLoadMore, useTotalCount
// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

function TaskList({
	userId,
	selectedTask,
	onSelectTask,
}: {
	userId: string;
	selectedTask: string | null;
	onSelectTask: (id: string | null) => void;
}) {
	const { rows: allTasks, insert, remove } = useSync<Task>("tasks");
	const totalCount = useTotalCount("tasks");
	const loadMore = useLoadMore("tasks");
	const [filter, setFilter] = useState<string>("all");
	const [showDeleted, setShowDeleted] = useState(false);

	// Also get tasks with deletedAt to showcase soft delete
	const { rows: allWithDeleted } = useSync<Task>("tasks", { includeDeleted: true });
	const deletedCount = allWithDeleted.length - allTasks.length;

	const filteredTasks = useMemo(() => {
		const source = showDeleted ? allWithDeleted : allTasks;
		if (filter === "all") return source;
		if (filter === "mine")
			return source.filter((t) => t.assignee === userId || t.createdBy === userId);
		return source.filter((t) => t.status === filter);
	}, [allTasks, allWithDeleted, filter, userId, showDeleted]);

	const addTask = useCallback(() => {
		const id = `task-${uid()}`;
		insert(id, {
			id,
			title: "New task",
			status: "todo",
			priority: "medium",
			projectId: "proj-1",
			createdBy: userId,
			createdAt: new Date().toISOString(),
			position: allTasks.length,
		} as Partial<Task>);
		onSelectTask(id);
	}, [insert, userId, allTasks.length, onSelectTask]);

	return (
		<div className="task-list">
			<div className="list-toolbar">
				<div className="filter-tabs">
					{["all", "todo", "in_progress", "done", "mine"].map((f) => (
						<button
							key={f}
							className={`filter-tab ${filter === f ? "active" : ""}`}
							onClick={() => setFilter(f)}
						>
							{f === "all" ? "All" : f === "mine" ? "Mine" : (STATUS_LABELS[f] ?? f)}
						</button>
					))}
				</div>
				<button className="add-btn" onClick={addTask}>
					+ New Task
				</button>
			</div>

			<div className="task-cards">
				{filteredTasks.map((task) => (
					<TaskCard
						key={task.id}
						taskId={task.id}
						onSelect={onSelectTask}
						isSelected={selectedTask === task.id}
					/>
				))}
				{filteredTasks.length === 0 && <div className="empty-state">No tasks yet. Create one!</div>}
			</div>

			<div className="list-footer">
				<span className="count">
					{allTasks.length} tasks
					{totalCount != null && totalCount > allTasks.length && <> of {totalCount} total</>}
					{deletedCount > 0 && (
						<button className="deleted-toggle" onClick={() => setShowDeleted(!showDeleted)}>
							{showDeleted ? "Hide" : "Show"} {deletedCount} deleted
						</button>
					)}
				</span>
				{totalCount != null && totalCount > allTasks.length && (
					<button className="load-more-btn" onClick={() => loadMore(20)}>
						Load more
					</button>
				)}
			</div>
		</div>
	);
}

// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
// COMMENTS — useSync with eager broadcast
// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

function Comments({ taskId, userId }: { taskId: string; userId: string }) {
	const { rows: comments, insert } = useSync<Comment>("comments");
	const [text, setText] = useState("");
	const scrollRef = useRef<HTMLDivElement>(null);

	// Typing indicator via ephemeral
	const { events: typingEvents, broadcast: broadcastTyping } = useEphemeral<{ typing: boolean }>({
		key: `typing:${taskId}`,
		userId,
		ttlMs: 3000,
	});

	const taskComments = useMemo(
		() =>
			comments
				.filter((c) => c.taskId === taskId)
				.sort((a, b) => a.createdAt.localeCompare(b.createdAt)),
		[comments, taskId],
	);

	// Auto-scroll on new comments
	useEffect(() => {
		scrollRef.current?.scrollTo({ top: scrollRef.current.scrollHeight, behavior: "smooth" });
	}, [taskComments.length]);

	const typingUsers = Object.entries(typingEvents)
		.filter(([uid, data]) => uid !== userId && data.typing)
		.map(([uid]) => uid);

	const handleSubmit = (e: React.FormEvent) => {
		e.preventDefault();
		if (!text.trim()) return;
		const id = `comment-${uid()}`;
		insert(id, {
			id,
			taskId,
			text: text.trim(),
			authorId: userId,
			createdAt: new Date().toISOString(),
		} as Partial<Comment>);
		setText("");
		broadcastTyping({ typing: false });
	};

	const handleInput = (val: string) => {
		setText(val);
		broadcastTyping({ typing: val.length > 0 });
	};

	return (
		<div className="comments-section">
			<h3>Comments</h3>
			<div className="comments-list" ref={scrollRef}>
				{taskComments.map((c) => (
					<div key={c.id} className={`comment ${c.authorId === userId ? "mine" : ""}`}>
						<span className="comment-author">@{c.authorId}</span>
						<span className="comment-text">{c.text}</span>
						<span className="comment-time">{timeAgo(c.createdAt)}</span>
					</div>
				))}
				{taskComments.length === 0 && <div className="empty-comments">No comments yet</div>}
			</div>
			{typingUsers.length > 0 && (
				<div className="typing-indicator">{typingUsers.join(", ")} typing...</div>
			)}
			<form className="comment-form" onSubmit={handleSubmit}>
				<input
					type="text"
					value={text}
					onChange={(e) => handleInput(e.target.value)}
					placeholder="Add a comment..."
					className="comment-input"
				/>
				<button type="submit" className="send-btn" disabled={!text.trim()}>
					Send
				</button>
			</form>
		</div>
	);
}

// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
// TASK DETAIL — useRow, update, delete (soft), conflict merge
// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

function TaskDetail({
	taskId,
	userId,
	onClose,
}: {
	taskId: string;
	userId: string;
	onClose: () => void;
}) {
	const task = useRow<Task>("tasks", taskId);
	const { update, remove } = useSync<Task>("tasks");

	if (!task) {
		return (
			<div className="detail-panel">
				<div className="detail-header">
					<h2>Task not found</h2>
					<button className="close-btn" onClick={onClose}>
						&times;
					</button>
				</div>
			</div>
		);
	}

	const isDeleted = !!task.deletedAt;

	return (
		<div className="detail-panel">
			<div className="detail-header">
				<h2>
					{isDeleted && <span className="deleted-label">DELETED</span>}
					Task Detail
				</h2>
				<button className="close-btn" onClick={onClose}>
					&times;
				</button>
			</div>

			<div className="detail-body">
				{/* Title — editable inline */}
				<input
					className="detail-title"
					value={task.title}
					onChange={(e) => update(taskId, { title: e.target.value })}
					disabled={isDeleted}
				/>

				{/* Description — editable textarea */}
				<textarea
					className="detail-description"
					value={task.description ?? ""}
					onChange={(e) => update(taskId, { description: e.target.value })}
					placeholder="Add a description..."
					rows={3}
					disabled={isDeleted}
				/>

				{/* Fields */}
				<div className="detail-fields">
					<label>Status</label>
					<select
						value={task.status}
						onChange={(e) => update(taskId, { status: e.target.value })}
						disabled={isDeleted}
					>
						<option value="todo">To Do</option>
						<option value="in_progress">In Progress</option>
						<option value="done">Done</option>
					</select>

					<label>Priority</label>
					<select
						value={task.priority}
						onChange={(e) => update(taskId, { priority: e.target.value })}
						disabled={isDeleted}
					>
						<option value="low">Low</option>
						<option value="medium">Medium</option>
						<option value="high">High</option>
					</select>

					<label>Assignee</label>
					<select
						value={task.assignee ?? ""}
						onChange={(e) => update(taskId, { assignee: e.target.value || null })}
						disabled={isDeleted}
					>
						<option value="">Unassigned</option>
						<option value="alice">Alice</option>
						<option value="bob">Bob</option>
					</select>

					{/* Read-only server fields */}
					<label>Created by</label>
					<span className="readonly-field">{task.createdBy}</span>

					<label>Created at</label>
					<span className="readonly-field">
						{task.createdAt ? new Date(task.createdAt).toLocaleString() : "—"}
					</span>

					<label>Updated at</label>
					<span className="readonly-field">
						{task.updatedAt ? new Date(task.updatedAt).toLocaleString() : "—"}
					</span>
				</div>

				{/* Delete button */}
				{!isDeleted && (
					<button className="delete-btn" onClick={() => remove(taskId)}>
						Delete Task
					</button>
				)}
			</div>

			{/* Comments — eager broadcast */}
			<Comments taskId={taskId} userId={userId} />
		</div>
	);
}

// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
// PROJECT SIDEBAR — useSync
// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

function ProjectSidebar({
	selectedProject,
	onSelectProject,
}: {
	selectedProject: string;
	onSelectProject: (id: string) => void;
}) {
	const { rows: projects, insert } = useSync<Project>("projects");

	const addProject = () => {
		const id = `proj-${uid()}`;
		const colors = ["#6366f1", "#f59e0b", "#10b981", "#ec4899", "#8b5cf6"];
		insert(id, {
			id,
			name: `Project ${projects.length + 1}`,
			color: colors[projects.length % colors.length]!,
			createdBy: getUser().userId,
		} as Partial<Project>);
	};

	return (
		<div className="sidebar">
			<div className="sidebar-header">
				<h2>Projects</h2>
				<button className="add-project-btn" onClick={addProject} title="New project">
					+
				</button>
			</div>
			<div className="project-list">
				{projects.map((p) => (
					<button
						key={p.id}
						className={`project-item ${selectedProject === p.id ? "active" : ""}`}
						onClick={() => onSelectProject(p.id)}
					>
						<span className="project-dot" style={{ background: p.color }} />
						{p.name}
					</button>
				))}
			</div>
		</div>
	);
}

// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
// CODE PANEL — side-by-side code examples
// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

const CODE_EXAMPLES = [
	{
		title: "Basic Sync",
		desc: "Subscribe to a table, get reactive rows + mutations",
		code: `const { rows, insert, update, remove }
  = useSync<Task>("tasks");

// Insert a new task (optimistic)
insert("task-1", {
  id: "task-1",
  title: "Ship v1",
  status: "todo",
});

// Update (merge conflict-safe)
update("task-1", { status: "done" });

// Soft delete
remove("task-1");`,
	},
	{
		title: "Server Query",
		desc: "Auth-scoped queries with serverSet & readonly fields",
		code: `server.query("tasks",
  (ctx, db) => db.select()
    .from(tasks)
    .where(eq(tasks.projectId,
      ctx.params.projectId)),
  {
    tables: ["tasks"],
    conflict: "merge",
    serverSet: {
      createdBy: (ctx) => ctx.auth.userId,
      updatedAt: () => new Date().toISOString(),
    },
    readonly: ["createdAt", "createdBy"],
    mutate: async (op, ctx, db) => { ... },
    authorize: async (action, ctx) => { ... },
  },
);`,
	},
	{
		title: "Windowed Sync",
		desc: "Load data in pages with total count",
		code: `// Client: initial window of 50 rows
const { rows } = useSync("tasks", {
  window: 50,
});

// Load 20 more rows
const loadMore = useLoadMore("tasks");
loadMore(20);

// Total count (opt-in via countHints)
const total = useTotalCount("tasks");
// "Showing 50 of 1,234"`,
	},
	{
		title: "Ephemeral Presence",
		desc: "Transient events with auto-expiry (cursors, typing)",
		code: `const { events, broadcast }
  = useEphemeral<{ name: string }>({
    key: "presence",
    userId: "alice",
    ttlMs: 10000,
  });

// Broadcast presence
broadcast({ name: "Alice" });

// events = { bob: { name: "Bob" } }
// Auto-expires after ttlMs`,
	},
	{
		title: "Eager Broadcast",
		desc: "Real-time comments — broadcast first, persist later",
		code: `// Server: eager broadcast mode
server.query("comments", callback, {
  tables: ["comments"],
  broadcast: "eager",
  // Broadcast immediately to all clients
  // Batch-persist to DB in background
  // ~200ms flush interval
});

// Client: same API, instant delivery
const { rows, insert }
  = useSync<Comment>("comments");`,
	},
	{
		title: "Connection Status",
		desc: "Reactive state machine + pending ops count",
		code: `const status = useSyncStatus();
// "hydrating" → "disconnected"
// → "connecting" → "connected"
// → "bootstrapping" → "synced"

const pending = usePendingCount();
// Number of unsynced local ops
// Decrements as server acks arrive`,
	},
	{
		title: "Room Scoping",
		desc: "Isolate sync to a room (project, channel, etc)",
		code: `// Server: room pattern with auth
server.room("project/:projectId",
  async ({ params, auth }) => {
    return { ok: true };
});

// Client: params derive room key
useSync("tasks", {
  params: { projectId: "proj-1" },
});

// Broadcasts scoped to same room`,
	},
	{
		title: "Single Row",
		desc: "Subscribe to a single row reactively",
		code: `// Re-renders only when this row changes
const task = useRow<Task>("tasks", taskId);

if (!task) return <NotFound />;
return <h1>{task.title}</h1>;

// Efficient: uses per-table
// subscriptions under the hood`,
	},
	{
		title: "Conflict Resolution",
		desc: "Column-level merge — two users edit different fields",
		code: `// "merge" conflict policy:
// Alice updates title, Bob updates status
// Both writes preserved (per-column HLC)

// "lww" — last write wins (default)
// "server" — first write locks row
// "custom" — your resolver function

{
  conflict: "merge",
  // or: { policy: "custom",
  //   resolve: (incoming, existing) => ... }
}`,
	},
	{
		title: "Observability",
		desc: "Server lifecycle events for monitoring",
		code: `createServer({
  onEvent: (event) => {
    switch (event.type) {
      case "client_connected":
      case "client_disconnected":
      case "auth_failed":
      case "ops_processed":
      case "bootstrap":
      case "resume":
      case "compaction":
      case "queue_overflow":
      case "ephemeral_full":
        metrics.emit(event);
    }
  },
});`,
	},
	{
		title: "Offline-First",
		desc: "IndexedDB persistence — instant cached renders",
		code: `import { createIndexedDBStorage }
  from "reflectdb/client/storage/indexeddb";

<SyncProvider
  url="ws://localhost:3002/sync"
  token="alice-token"
  tables={["tasks"]}
  storage={createIndexedDBStorage({
    dbName: "my-app",
  })}
>
  {/* Renders cached data instantly */}
  {/* Delta resume on reconnect */}
</SyncProvider>`,
	},
	{
		title: "Auth + Rate Limit",
		desc: "Per-request auth, per-user rate limiting",
		code: `// Auth: token on every request
server.auth(async (req) => {
  const token = req.headers
    .get("authorization")
    ?.replace("Bearer ", "");
  const user = await verifyJwt(token);
  return { userId: user.id };
});

// Rate limit: per-user, per-client
server.rateLimit({
  opsPerSecond: 50,
  opsPerMinute: 500,
});`,
	},
];

function CodePanel({ isOpen, onToggle }: { isOpen: boolean; onToggle: () => void }) {
	const [activeExample, setActiveExample] = useState(0);

	return (
		<div className={`code-panel ${isOpen ? "open" : "closed"}`}>
			<button className="code-panel-toggle" onClick={onToggle}>
				{isOpen ? "Hide Code" : "</> Code"}
			</button>

			{isOpen && (
				<>
					<div className="code-tabs">
						{CODE_EXAMPLES.map((ex, i) => (
							<button
								key={i}
								className={`code-tab ${activeExample === i ? "active" : ""}`}
								onClick={() => setActiveExample(i)}
							>
								{ex.title}
							</button>
						))}
					</div>
					<div className="code-content">
						<div className="code-desc">{CODE_EXAMPLES[activeExample]!.desc}</div>
						<pre className="code-block">
							<code>{CODE_EXAMPLES[activeExample]!.code}</code>
						</pre>
					</div>
				</>
			)}
		</div>
	);
}

// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
// MAIN APP
// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

function AppContent() {
	const user = getUser();
	const [selectedProject, setSelectedProject] = useState("proj-1");
	const [selectedTask, setSelectedTask] = useState<string | null>(null);
	const [codeOpen, setCodeOpen] = useState(true);

	return (
		<div className="app-layout">
			{/* Header */}
			<header className="app-header">
				<div className="header-left">
					<h1>reflectdb</h1>
					<span className="header-subtitle">showcase</span>
				</div>
				<div className="header-right">
					<PresenceBar userId={user.userId} />
					<StatusBadge />
					<span className="user-badge">{user.name}</span>
				</div>
			</header>

			{/* Body */}
			<div className="app-body">
				<ProjectSidebar selectedProject={selectedProject} onSelectProject={setSelectedProject} />

				<div className="main-content">
					<TaskList
						userId={user.userId}
						selectedTask={selectedTask}
						onSelectTask={setSelectedTask}
					/>
				</div>

				{selectedTask && (
					<TaskDetail
						taskId={selectedTask}
						userId={user.userId}
						onClose={() => setSelectedTask(null)}
					/>
				)}
			</div>

			{/* Code examples */}
			<CodePanel isOpen={codeOpen} onToggle={() => setCodeOpen(!codeOpen)} />
		</div>
	);
}

export function App() {
	const user = getUser();

	return (
		<SyncProvider
			url="ws://localhost:3002/sync"
			token={user.token}
			tables={["projects", "tasks", "comments"]}
		>
			<AppContent />
		</SyncProvider>
	);
}

export default App;
