import { SignIn, UserButton, useAuth } from "@clerk/react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useMemo, useState, type FormEvent } from "react";
import { NavLink, useLocation, useNavigate } from "react-router-dom";
import { ApiClient } from "./api";

const navigation = [
  "Overview",
  "Tasks",
  "Agents",
  "Documents",
  "Messages",
  "Activity",
  "Integrations",
  "Settings"
];
const projectPath = /^\/projects\/([^/]+)/;

function CreateForm({
  label,
  pending,
  onCreate
}: {
  label: string;
  pending: boolean;
  onCreate(name: string): Promise<unknown>;
}) {
  const [name, setName] = useState("");
  const [error, setError] = useState("");

  const submit = async (event: FormEvent) => {
    event.preventDefault();
    setError("");
    try {
      await onCreate(name);
      setName("");
    } catch (caught) {
      setError(
        caught instanceof Error ? caught.message : "The request failed."
      );
    }
  };

  return (
    <form className="create-form" onSubmit={submit}>
      <label>
        {label} name
        <input
          autoFocus
          maxLength={120}
          onChange={(event) => setName(event.target.value)}
          required
          value={name}
        />
      </label>
      {error ? <p className="form-error">{error}</p> : null}
      <button disabled={pending} type="submit">
        {pending ? "Creating…" : `Create ${label.toLowerCase()}`}
      </button>
    </form>
  );
}

function SetupCard({
  description,
  label,
  onCreate,
  pending
}: {
  description: string;
  label: string;
  onCreate(name: string): Promise<unknown>;
  pending: boolean;
}) {
  return (
    <main className="setup-screen">
      <p className="eyebrow">GET STARTED</p>
      <h1>Create your {label.toLowerCase()}</h1>
      <p>{description}</p>
      <section className="setup-card">
        <CreateForm label={label} onCreate={onCreate} pending={pending} />
      </section>
    </main>
  );
}

function Dashboard() {
  const { getToken } = useAuth();
  const api = useMemo(() => new ApiClient(getToken), [getToken]);
  const queryClient = useQueryClient();
  const location = useLocation();
  const navigate = useNavigate();
  const [organizationSelection, setOrganizationSelection] = useState("");
  const [workspaceSelection, setWorkspaceSelection] = useState("");

  const organizationsQuery = useQuery({
    queryFn: () => api.listOrganizations(),
    queryKey: ["organizations"]
  });
  const organizations = organizationsQuery.data?.organizations ?? [];
  const organizationId = organizations.some(
    (item) => item.id === organizationSelection
  )
    ? organizationSelection
    : (organizations[0]?.id ?? "");

  const workspacesQuery = useQuery({
    enabled: Boolean(organizationId),
    queryFn: () => api.listWorkspaces(organizationId),
    queryKey: ["workspaces", organizationId]
  });
  const workspaces = workspacesQuery.data?.workspaces ?? [];
  const workspaceId = workspaces.some((item) => item.id === workspaceSelection)
    ? workspaceSelection
    : (workspaces[0]?.id ?? "");

  const projectsQuery = useQuery({
    enabled: Boolean(workspaceId),
    queryFn: () => api.listProjects(workspaceId),
    queryKey: ["projects", workspaceId]
  });
  const projects = projectsQuery.data?.projects ?? [];
  const routeProjectId = location.pathname.match(projectPath)?.[1];
  const project =
    projects.find((item) => item.id === routeProjectId) ?? projects[0] ?? null;

  const createOrganization = useMutation({
    mutationFn: (name: string) => api.createOrganization({ name }),
    onSuccess: async (organization) => {
      setOrganizationSelection(organization.id);
      setWorkspaceSelection("");
      navigate("/");
      await queryClient.invalidateQueries({ queryKey: ["organizations"] });
    }
  });
  const createWorkspace = useMutation({
    mutationFn: (name: string) => api.createWorkspace(organizationId, { name }),
    onSuccess: async (workspace) => {
      setWorkspaceSelection(workspace.id);
      navigate("/");
      await queryClient.invalidateQueries({
        queryKey: ["workspaces", organizationId]
      });
    }
  });
  const createProject = useMutation({
    mutationFn: (name: string) => api.createProject(workspaceId, { name }),
    onSuccess: async (created) => {
      await queryClient.invalidateQueries({
        queryKey: ["projects", workspaceId]
      });
      navigate(`/projects/${created.id}`);
    }
  });

  if (organizationsQuery.isPending)
    return <div className="loading">Loading workspace…</div>;
  if (organizationsQuery.error) {
    return (
      <div className="loading error">{organizationsQuery.error.message}</div>
    );
  }
  if (!organizations.length) {
    return (
      <SetupCard
        description="Organizations are the membership and security boundary for your work."
        label="Organization"
        onCreate={(name) => createOrganization.mutateAsync(name)}
        pending={createOrganization.isPending}
      />
    );
  }
  if (workspacesQuery.isPending)
    return <div className="loading">Loading workspaces…</div>;
  if (workspacesQuery.error) {
    return <div className="loading error">{workspacesQuery.error.message}</div>;
  }
  if (!workspaces.length) {
    return (
      <SetupCard
        description="Workspaces group related projects inside this organization."
        label="Workspace"
        onCreate={(name) => createWorkspace.mutateAsync(name)}
        pending={createWorkspace.isPending}
      />
    );
  }
  if (projectsQuery.isPending)
    return <div className="loading">Loading projects…</div>;
  if (projectsQuery.error) {
    return <div className="loading error">{projectsQuery.error.message}</div>;
  }
  if (!projects.length) {
    return (
      <SetupCard
        description="Projects are where humans and agents will coordinate shared work."
        label="Project"
        onCreate={(name) => createProject.mutateAsync(name)}
        pending={createProject.isPending}
      />
    );
  }

  const section =
    navigation.find(
      (item) => item.toLowerCase() === location.pathname.split("/").at(-1)
    ) ?? "Overview";
  const pathFor = (item: string) =>
    `/projects/${project!.id}${item === "Overview" ? "" : `/${item.toLowerCase()}`}`;

  return (
    <div className="shell">
      <aside>
        <div className="brand">
          ORCHESTRAT<span>DEV</span>
        </div>
        <div className="selectors">
          <label>
            Organization
            <select
              onChange={(event) => {
                setOrganizationSelection(event.target.value);
                setWorkspaceSelection("");
                navigate("/");
              }}
              value={organizationId}
            >
              {organizations.map((item) => (
                <option key={item.id} value={item.id}>
                  {item.name}
                </option>
              ))}
            </select>
          </label>
          <label>
            Workspace
            <select
              onChange={(event) => {
                setWorkspaceSelection(event.target.value);
                navigate("/");
              }}
              value={workspaceId}
            >
              {workspaces.map((item) => (
                <option key={item.id} value={item.id}>
                  {item.name}
                </option>
              ))}
            </select>
          </label>
        </div>
        <nav>
          {navigation.map((item) => (
            <NavLink end={item === "Overview"} key={item} to={pathFor(item)}>
              {item}
            </NavLink>
          ))}
        </nav>
        <div className="sidebar-footer">
          <span>SYSTEM / CONNECTED</span>
          <UserButton />
        </div>
      </aside>
      <div className="workspace">
        <header>
          <div>
            <p>PROJECT</p>
            <select
              aria-label="Project switcher"
              onChange={(event) => navigate(`/projects/${event.target.value}`)}
              value={project!.id}
            >
              {projects.map((item) => (
                <option key={item.id} value={item.id}>
                  {item.name}
                </option>
              ))}
            </select>
          </div>
          <details className="new-project">
            <summary>New project</summary>
            <CreateForm
              label="Project"
              onCreate={(name) => createProject.mutateAsync(name)}
              pending={createProject.isPending}
            />
          </details>
        </header>
        <main className="content">
          <p className="eyebrow">{project!.slug.toUpperCase()}</p>
          <h1>{section}</h1>
          <section className="placeholder">
            <p>
              {section === "Overview"
                ? "This project is ready."
                : `No ${section.toLowerCase()} yet.`}
            </p>
            <span>
              {section === "Overview"
                ? "Tasks and agents arrive in later phases; the durable project boundary is active now."
                : "This surface remains empty until its dedicated product phase."}
            </span>
          </section>
        </main>
      </div>
    </div>
  );
}

export function App() {
  const { isLoaded, isSignedIn } = useAuth();
  if (!isLoaded) return <div className="loading">Loading session…</div>;
  if (!isSignedIn) {
    return (
      <main className="sign-in-screen">
        <div>
          <p className="eyebrow">ORCHESTRAT / HUMAN ACCESS</p>
          <h1>Coordinate the work.</h1>
          <p>Sign in to open your organizations, workspaces, and projects.</p>
        </div>
        <SignIn routing="hash" />
      </main>
    );
  }
  return <Dashboard />;
}
