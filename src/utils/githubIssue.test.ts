import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createGithubIssue, parseGithubRepository } from "./githubIssue.ts";

describe("parseGithubRepository", () => {
  it("splits a real 'owner/repo' string", () => {
    expect(parseGithubRepository("makshinde/parking-app")).toEqual({ owner: "makshinde", repo: "parking-app" });
  });

  it("throws on a value with no slash", () => {
    expect(() => parseGithubRepository("parking-app")).toThrow(/expected "owner\/repo"/);
  });

  it("throws on a value with more than one slash", () => {
    expect(() => parseGithubRepository("a/b/c")).toThrow(/expected "owner\/repo"/);
  });

  it("throws on an empty owner or repo segment", () => {
    expect(() => parseGithubRepository("/parking-app")).toThrow(/expected "owner\/repo"/);
    expect(() => parseGithubRepository("makshinde/")).toThrow(/expected "owner\/repo"/);
  });
});

describe("createGithubIssue", () => {
  let fetchMock: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("POSTs to the real GitHub issues endpoint with the real title/body/labels and auth header", async () => {
    fetchMock.mockResolvedValueOnce({
      ok: true,
      status: 201,
      statusText: "Created",
      json: () => Promise.resolve({ number: 42, html_url: "https://github.com/makshinde/parking-app/issues/42" }),
    });

    const result = await createGithubIssue("test-token", {
      repository: { owner: "makshinde", repo: "parking-app" },
      title: "Real title",
      body: "Real body",
      labels: ["automated"],
    });

    expect(result).toEqual({ issueNumber: 42, url: "https://github.com/makshinde/parking-app/issues/42" });
    expect(fetchMock).toHaveBeenCalledWith(
      "https://api.github.com/repos/makshinde/parking-app/issues",
      expect.objectContaining({
        method: "POST",
        headers: expect.objectContaining({
          Authorization: "Bearer test-token",
          Accept: "application/vnd.github+json",
        }),
      }),
    );
    const call = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(JSON.parse(call[1].body as string)).toEqual({ title: "Real title", body: "Real body", labels: ["automated"] });
  });

  it("defaults labels to an empty array when omitted", async () => {
    fetchMock.mockResolvedValueOnce({
      ok: true,
      status: 201,
      statusText: "Created",
      json: () => Promise.resolve({ number: 1, html_url: "https://github.com/makshinde/parking-app/issues/1" }),
    });

    await createGithubIssue("test-token", { repository: { owner: "makshinde", repo: "parking-app" }, title: "t", body: "b" });

    const call = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(JSON.parse(call[1].body as string).labels).toEqual([]);
  });

  it("throws with the real response body when GitHub rejects the request", async () => {
    fetchMock.mockResolvedValueOnce({
      ok: false,
      status: 401,
      statusText: "Unauthorized",
      text: () => Promise.resolve('{"message":"Bad credentials"}'),
    });

    await expect(
      createGithubIssue("bad-token", { repository: { owner: "makshinde", repo: "parking-app" }, title: "t", body: "b" }),
    ).rejects.toThrow(/401 Unauthorized.*Bad credentials/s);
  });
});
