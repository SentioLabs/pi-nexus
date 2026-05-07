import type { StatuslineRenderer } from "@sentiolabs/pi-scriptable-statusline";

const render: StatuslineRenderer = async (input) => {
  const branch = input.git.branch ?? "no-git";
  const context = input.context.percent === null ? "ctx ?" : `ctx ${input.context.percent}%`;
  const daily = input.limits.daily?.label ?? "daily ?";
  const weekly = input.limits.weekly?.label ?? "weekly ?";
  const statuses = input.extensionStatuses.map((status) => status.text).filter(Boolean);

  return {
    footer: [
      `${input.model.label} · ${input.repo.name} · ${branch}`,
      `${context} · ${input.tokens.totalLabel} · ${input.cost.totalLabel} · ${daily} · ${weekly}`,
    ],
    widgets: {
      belowEditor: statuses.length > 0 ? [`statuses: ${statuses.join(" · ")}`] : [],
    },
    status: `${context} · ${input.model.label}`,
  };
};

export default render;
