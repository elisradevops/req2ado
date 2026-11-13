# req2ado User Guide

## What this tool does

Converts a requirements document (contract, survey, or engineering spec) into a structured Epic → Feature → Requirement hierarchy in Azure DevOps.

## First-day setup

Three connections feed the app. The status line at the bottom of the navigation reads **All systems OK** when they work; click it to see which one needs attention.

1. **Azure DevOps.** Connected when you sign in. If it lapses, open the account menu (your name, top right), choose **Profile & connections** (the page is titled Profile and connections), and reconnect there.
2. **AI model (Open WebUI).** Needed before your first job. In **Profile and connections**, open **Configure** on the Open WebUI row, paste an API key from your Open WebUI account, press **Load models**, pick a model and save. The app cannot create the key for you.
3. **SharePoint (knowledge base only).** Skip this if you do not use a knowledge base. On **Knowledge base**, press **Reconnect**. The dialog links to Graph Explorer and lists the three steps: sign in there, copy the access token, paste it back. The page then shows when the connection expires; reconnect when it does. One token serves everyone who uses the knowledge base.

## Modes

- **Baseline** — verbatim extraction. The tool never rewrites your text; titles are truncated (not summarized) from the source, and every requirement's description is byte-for-byte traceable back to the source document via a fidelity hash. Use this for signed contracts and formal specs where wording must not change.
- **Survey** — generative. The tool uses an AI model to turn informal notes into formal "shall"-style requirements, merges near-duplicate clauses, infers parents the numbering implies but never states, and scores each requirement for quality. Use this for early-stage or informally-written requirements. Takes much longer than Baseline on a real document and uses model quota; the New job page shows an estimate for your document before you start.

## Workflow

1. **Upload** a document and specify the target Azure DevOps area path.
2. The tool ingests the document, infers a hierarchy, and computes a **dry-run diff** — a preview of what would be created or reused, without writing anything to Azure DevOps yet.
3. Review the diff. Each row shows whether that item would be newly created or would reuse an existing Azure DevOps work item (re-running the same document never creates duplicates).
4. Deal with everything under **Fix before writing**: **Write to Azure DevOps** stays greyed out, with the reason beside it ("7 items to fix before writing"), until each of those items is reviewed or excluded. Pressing the greyed button takes you to what is blocking it. One exception: if the document simply has no Customer IDs, you can accept all of those requirements at once ("Accept 7 without a Customer ID"), and take it back with **Undo acceptance**.
5. Click **Write to Azure DevOps** to perform the actual write — this cannot be undone from req2ado; items must be deleted directly in Azure DevOps afterward.

## Reviewing the proposed items

The toolbar groups what is left to decide: **Fix before writing** (must be dealt with before you can write), **Check** (a low score, a review warning, or wording that strays from the source), **Clean** (nothing flagged; approve them together after looking at a sample) and **Structure** (Epics and Features, which are not scored and come last). Press a group to show only its items. **Review in risk order** walks through them one at a time, riskiest first, and says where you are ("3 of 17").

### Keyboard shortcuts while reviewing

Open an item (or start **Review in risk order**), then:

| Key | Does |
|---|---|
| **J** | next item |
| **K** | previous item |
| **A** or **R** | mark the item reviewed and go to the next |
| **X** | exclude the item and go to the next |
| **E** | edit the item |
| **U** | undo the last review action |
| **Esc** | close the item |

The single-key shortcuts can be switched off under **Profile and connections** (account menu, top right). The first link on a job page, **Skip to proposed items**, jumps straight to the list.

## The Jobs list

Jobs are grouped: **Needs you** first (a job waiting for review, or one that failed, in the last week), then **Today**, **Yesterday**, **This week** and **Earlier**. A proposal that has waited more than a week is labelled **Stale**: the proposal was worked out against Azure DevOps as it was then, so look again before you write it. Nothing is deleted for being old. If the list is long, tick **Hide stale** to take them out of view (untick it to bring them back); the choice is remembered for you. On a narrow screen the less useful columns drop away (area path first, then mode and items), and on a phone only the document and its state are shown. Each job shows its short id (the start of its address), so two uploads of the same file name can be told apart.

## Customer ID

If your Azure DevOps project has a custom "Customer ID" field, the tool automatically detects its real field name (it checks a few common naming conventions) — you don't need to configure this yourself in most cases.

## Troubleshooting

- **"Upload failed"** — check that the file format is supported (txt, md, docx, pdf, scanned PDF, xlsx) and that the Area Path field is filled in.
- **Diff never becomes ready** — the ingestion service may be unreachable; contact your administrator.
