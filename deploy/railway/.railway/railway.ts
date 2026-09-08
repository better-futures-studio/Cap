import {
	defineRailway,
	github,
	group,
	mysql,
	postgres,
	project,
	ref,
	service,
} from "railway/iac";

// Railway IaC template for a new company instance of this fork.
// third parties are added as they are provided; empty strings are placeholders.
export default defineRailway(() => {
	const Cap = github("better-futures-studio/Cap", { checkSuites: false });
	const R = "iad";

	const Postgres = postgres("Postgres", { region: R });
	const MySQL = mysql("MySQL", { region: R });
	MySQL.deploy = {
		startCommand:
			"docker-entrypoint.sh mysqld --innodb-use-native-aio=0 --disable-log-bin --performance_schema=0",
	};

	const MEDIA_SERVER_WEBHOOK_SECRET = "<openssl rand -hex 32>";
	const CRON_SECRET = "<openssl rand -hex 32>";
	const WEB_URL = "https://<your-domain>";

	const MediaServer = service("media-server", {
		source: Cap,
		build: {
			builder: "DOCKERFILE",
			dockerfilePath: "apps/media-server/Dockerfile",
		},
		replicas: { [R]: 1 },
		deploy: {
			limitOverride: { containers: { cpu: 8, memoryBytes: 8589934592 } },
			sleepApplication: true,
		},
		networking: { privateNetworkEndpoint: "media-server" },
		env: { MEDIA_SERVER_WEBHOOK_SECRET, PORT: "3456" },
	});

	const CapWeb = service("Cap Web", {
		source: Cap,
		build: { builder: "DOCKERFILE", dockerfilePath: "apps/web/Dockerfile" },
		replicas: { [R]: 1 },
		deploy: {
			limitOverride: { containers: { cpu: 4, memoryBytes: 4294967296 } },
			sleepApplication: true,
		},
		networking: { privateNetworkEndpoint: "cap-web" },
		env: {
			PORT: "3000",
			DOCKER_BUILD: "true",
			WEB_URL,
			NEXTAUTH_URL: WEB_URL,
			NEXTAUTH_SECRET: "<openssl rand -hex 24>",
			DATABASE_ENCRYPTION_KEY: "<openssl rand -hex 16>",
			DATABASE_URL: ref(MySQL, "MYSQL_URL"),
			WORKFLOW_POSTGRES_URL: ref(Postgres, "DATABASE_URL"),
			WORKFLOW_WORKER_EXTERNAL: "true",
			MEDIA_SERVER_URL: "http://media-server.railway.internal:3456",
			MEDIA_SERVER_WEBHOOK_URL: "http://cap-web.railway.internal:3000",
			MEDIA_SERVER_WEBHOOK_SECRET,
			CRON_SECRET,
			CAP_DISABLE_EMAIL_LOGIN: "true",
			CAP_DISABLE_ORG_CREATION: "true",
			CAP_ALLOWED_SIGNUP_DOMAINS: "<your-domain>",
			AI_PROVIDER: "openai",
			AI_MODEL: "chat-latest",
			AI_CHAT_MODEL: "chat-latest",
			AI_STREAM_MODEL: "chat-latest",
			RESEND_FROM_DOMAIN: "<your-domain>",
			CAP_AWS_BUCKET: "<bucket>",
			CAP_AWS_REGION: "auto",
			S3_PATH_STYLE: "true",
			RECALL_REGION: "us-west-2",
			RECALL_BOT_NAME: "<Company> Notetaker",
			RECALL_TRANSCRIPTION_PROVIDER: "assemblyai",
			RECALL_LIVE_AGENT: "true",
			RECALL_DELETE_MEDIA_AFTER_IMPORT: "false",
		},
	});

	const CapWorker = service("Cap Worker", {
		source: Cap,
		build: {
			builder: "DOCKERFILE",
			dockerfilePath: "apps/web/Dockerfile.worker",
		},
		start: "node apps/web/workflow-worker.mjs",
		replicas: { [R]: 1 },
		deploy: {
			limitOverride: { containers: { cpu: 1, memoryBytes: 1073741824 } },
		},
		networking: { privateNetworkEndpoint: "cap-worker" },
		env: {
			NODE_ENV: "production",
			WORKFLOW_TARGET_WORLD: "@workflow/world-postgres",
			WORKFLOW_POSTGRES_URL: ref(Postgres, "DATABASE_URL"),
			WORKFLOW_LOCAL_BASE_URL: "http://cap-web.railway.internal:3000",
		},
	});

	const cron = service("cron", {
		source: Cap,
		build: {
			builder: "DOCKERFILE",
			dockerfilePath: "apps/web/Dockerfile.cron",
		},
		replicas: { [R]: 1 },
		deploy: { cronSchedule: "*/15 * * * *", restartPolicyType: "NEVER" },
		env: {
			CRON_SECRET,
			WEB_URL,
			MYSQLHOST: ref(MySQL, "MYSQLHOST"),
			MYSQLPORT: ref(MySQL, "MYSQLPORT"),
			MYSQLUSER: ref(MySQL, "MYSQLUSER"),
			MYSQLPASSWORD: ref(MySQL, "MYSQLPASSWORD"),
			MYSQLDATABASE: ref(MySQL, "MYSQLDATABASE"),
		},
	});

	return project("cap", {
		resources: [
			Postgres,
			cron,
			group("Cap", [CapWorker, CapWeb, MediaServer, MySQL]),
		],
	});
});
