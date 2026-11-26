"""The TV twin's target tree (the hand study, applied). Requirement texts come from the rendered document's own data (tv_twin.py, what the
PDF prints); the decisions, titles and types are the study's. Writes tv_gold_tree.json and fails if a self-check fails. Run it again
after changing build_tv_twin_pdf.py: `python build_tv_gold.py`.

Ladder (as the job builds the TV-remote mock): an area made only of sub-areas is an Epic; an area that holds requirements is a Feature
(a Feature may hold sub-areas, which are Features too); each coded paragraph is a Requirement; a coded sub-item (men_3.a) is a
sub-Requirement of its parent requirement. Only Epics are roots.

Descriptions (owner decisions, 2026-11-25): a Requirement's is its text verbatim without its code, lists and Notes kept (a full-width
Note printed after it included), then a blank line and the trace. An Epic's or Feature's is only the file's own text for it (the
context sections for the top Epic); with none it is empty, never the title repeated, never counts, never where it came from. `derived_marks` (TBD, Should, Will, No
obligation) are found in the text for review filters only and are never written; `file_tags` and `requirement_type` are what the file
states (this file states neither). Proposals (rename / drop_wrapper) apply by default (owner rule R4, 2026-11-26): the target holds the
proposed names and no removed level, its children moved up; the user may undo each before Start. `spelling` fixes are applied."""

from __future__ import annotations

import json
import re
import sys
from collections import Counter
from pathlib import Path

HERE = Path(__file__).parent
sys.path.insert(0, str(HERE))
import build_tv_twin_pdf as tv_twin  # noqa: E402

# heading -> (decision, title or None, reason). Decisions: keep, spelling (automatic), rename / drop_wrapper (proposals: applied, undoable).
DECISIONS = {
    "2 REQUIREMENTS": (
        "rename",
        "Vireo Television Set (VTS)",
        "A wrapper named 'Requirements' that holds both systems and the shared areas. Proposed: name it after the product on the cover, as the job does for the TV-remote mock.",
    ),
    "2.1 GENERAL": (
        "drop_wrapper",
        None,
        "A generic name holding only 'Product family'; it moves up a level.",
    ),
    "2.3.4 Enclousure": ("spelling", "Enclosure", "Spelling fixed automatically."),
    "2.4 DESIGN AND CONSTRUCTION": (
        "rename",
        "Environment and safety",
        "A generic name for an area that holds 'Environmental conditions' and 'Safety and EMC'. Proposed name taken from those two sections.",
    ),
}
TITLES = {
    "gen_1": "Set delivered with a paired VR-7 remote",
    "gen_2": "Same product family label on the packaging",
    "gen_3": "Product family covers 43, 55 and 65 inch screens",
    "tun_1": "Terrestrial tuner receives DVB-T2 broadcasts",
    "tun_2": "Terrestrial tuner locks to a channel within 1.5 s",
    "tun_3": "Terrestrial tuner decodes down to -82 dBm",
    "tun_4": "Terrestrial tuner shows signal strength and quality",
    "tun_5": "Terrestrial tuner keeps the channel on a weaker transmitter",
    "tun_6": "Satellite tuner receives DVB-S2 from four dish positions",
    "tun_7": "Satellite tuner supplies 13 V or 18 V to the dish",
    "tun_8": "Satellite tuner switches dish positions within 2 s",
    "tun_9": "Satellite tuner stores 4 000 channels",
    "tun_10": "Receiver scans all terrestrial channels within 4 min",
    "tun_11": "Receiver sorts channels by broadcaster numbers",
    "tun_12": "Receiver rescans the channel list overnight on a change",
    "tun_13": "Receiver limits the scan to one country",
    "dsp_1": "Panel shows 3840 by 2160 pixels at 120 Hz",
    "dsp_2": "Panel peak brightness of 600 cd/m²",
    "dsp_3": "Panel colour difference below 3",
    "dsp_4": "Panel shows no image retention",
    "dsp_5": "Panel backlight dims to 5 % in a dark room",
    "dsp_6": "Receiver offers the listed picture modes",
    "dsp_7": "Separate picture mode for each input",
    "dsp_8": "Game mode input delay below 15 ms",
    "dsp_9": "Receiver switches to Game mode for a console",
    "aud_1": "Two built-in speakers of 20 W",
    "aud_2": "Broadcast audio passed to a sound bar over eARC",
    "aud_3": "Advert volume within 2 dB of the programme",
    "aud_4": "Night mode compresses loud passages",
    "aud_5": "Speakers mute when headphones are plugged in",
    "aud_6": "Receiver plays audio description",
    "inp_1": "Four HDMI inputs, one with eARC",
    "inp_2": "HDMI inputs accept 4K at 120 Hz with variable refresh rate",
    "inp_3": "Receiver switches on from a CEC power-on command",
    "inp_4": "Receiver shows the connected device name",
    "inp_5": "Picture within 3 s of a new HDMI signal",
    "inp_6": "Receiver plays video files from exFAT USB storage",
    "inp_7": "USB ports supply 5 V at 900 mA",
    "inp_8": "Receiver records a broadcast to USB storage",
    "inp_9": "Receiver connects over Ethernet at 100 Mbit/s",
    "inp_10": "Receiver connects over Wi-Fi 6",
    "inp_11": "Keep streaming when bandwidth falls to 15 Mbit/s",
    "inp_12": "Receiver shows the network status",
    "inp_13": "Receiver accepts a screen cast from a phone",
    "men_1": "On-screen menu opens within 300 ms",
    "men_2": "Menu lists the five most recently used inputs",
    "men_3": "Menu shows the settings in order",
    "men_3.a": "Picture and sound settings come first",
    "men_3.b": "Network and software settings come last",
    "men_4": "Menu readable from 3 m on a 43 inch screen",
    "men_5": "Menu offers English, Dutch, German and French",
    "men_6": "Menu closes itself after 30 s",
    "": "Menu text contrast ratio of 4.5 to 1",
    "men_7": "Menu shows a help text for the selected setting",
    "men_8": "Menu restores the factory settings after a confirmation",
    "pwr_1": "Less than 0.5 W in standby",
    "pwr_2": "Start from standby to a picture within 4 s",
    "pwr_3": "Standby after 4 h without user action",
    "pwr_4": "Energy label class G or better",
    "pwr_5": "Mains supply of 100 V to 240 V at 50 Hz or 60 Hz",
    "pwr_6": "Keeps its settings after a loss of mains power",
    "btn_1": "Volume up and down buttons on the right side",
    "btn_2": "Volume up by one step within 150 ms",
    "btn_2.a": "Repeated volume steps suppressed while held",
    "btn_3": "Mute button next to the volume buttons",
    "btn_4": "Volume buttons told apart by touch",
    "btn_5": "Channel up and down buttons on the left side",
    "btn_6": "Digit buttons 0 to 9 for direct channel entry",
    "btn_7": "Receiver tunes to a typed channel after 2 s",
    "btn_8": "Button returns to the previous channel",
    "btn_9": "Four arrow keys around an OK key",
    "btn_10": "Home, Back, Menu, Settings, Guide and Info keys",
    "btn_11": "OK key is the largest key",
    "btn_12": "Holding an arrow key moves four steps per second",
    "btn_13": "Four colour keys for broadcaster functions",
    "irc_1": "Remote sends commands over infrared with NEC-32",
    "irc_2": "Infrared received from 8 m at up to 30°",
    "irc_3": "Infrared when no Bluetooth link is available",
    "irc_4": "Remote controls a sound bar over infrared",
    "blt_1": "Remote pairs over Bluetooth Low Energy without a code",
    "blt_2": "Remote pairs again when Home and Back are held",
    "blt_3": "Bluetooth link works from 10 m",
    "blt_4": "Remote reports its battery level over Bluetooth",
    "blt_5": "Receiver pairs with up to two remotes",
    "bat_1": "Remote runs on two LR03 batteries",
    "bat_2": "Batteries last 12 months",
    "bat_3": "Receiver warns when the remote battery falls below 10 %",
    "bat_4": "Remote sleeps within 5 s of the last key press",
    "bat_5": "Battery cover opens without tools",
    "enc_1": "Remote weighs less than 120 g",
    "enc_2": "Remote survives 500 drops from 1 m",
    "enc_3": "Key labels stay readable after 100 000 presses",
    "enc_4": "Remote at most 180 mm long and 45 mm wide",
    "env_1": "Set operates from 5 °C to 35 °C",
    "env_2": "Set operates at 20 % to 80 % relative humidity",
    "env_3": "Set stored from -20 °C to 60 °C",
    "env_4": "Remote operates from 0 °C to 40 °C",
    "env_5": "Set operates at altitudes up to 3 000 m",
    "env_6": "Packed set survives a 0.8 m drop",
    "env_7": "Fan noise below 25 dB(A) at 1 m",
    "saf_1": "Set meets the IEC-62368 safety requirements",
    "saf_2": "Set meets the EN-55032 class B emission limits",
    "saf_3": "Surfaces a user can touch not to exceed 70 °C",
    "saf_4": "Stand keeps the set upright on a 10° slope",
    "saf_5": "Remote battery compartment needs two movements to open",
    "sfw_1": "Last used input started after a cold start",
    "sfw_2": "Software keeps a log of the last 100 faults",
    "sfw_3": "Installed apps run in separate sandboxes",
    "sfw_4": "Asks for consent before it sends viewing data",
    "sfw_5": "Software recovers from an app crash without a restart",
    "sfw_6": "Software shows its version in the settings menu",
    "upd_1": "Receiver checks for a software update once a day",
    "upd_2": "Over-The-Air update installed only in standby",
    "upd_3": "Keeps the previous software after a failed update",
    "upd_4": "Receiver accepts an update from USB storage",
    "upd_5": "Update package signed by the manufacturer key",
    "tst_1": "End-of-line test of every input before packing",
    "tst_2": "Remote key and infrared test before packing",
    "bit_1": "Self-test of the panel and tuners from a service menu",
    "bit_2": "Self-test result shown as pass or fail with a fault code",
    "bit_3": "Self-test results stored with the test date",
}
EPIC_DESC = "\n".join(  # the sections the study confirms as context (1.1, 1.2), word for word
    p for sec in tv_twin.SECTIONS if sec.number in ("1.1", "1.2") for p in sec.prose
)
LEFT_OUT = [
    ("Cover, notices, contents", "left_out", "Front matter: pages 1-2."),
    (
        "1 INTRODUCTION, 1.1 IDENTIFICATION, 1.2 DOCUMENT OVERVIEW",
        "context",
        "Describe the document; their text is the top Epic's description.",
    ),
    (
        "1.3 REVISION HISTORY, 1.4 REFERENCES, 1.5 ABBREVIATIONS AND DEFINITIONS",
        "left_out",
        "Front matter (pages 3-4).",
    ),
    ("2.2.7 Interchangeability", "empty", 'Its whole text is "None.": nothing to plan.'),
    ("2.3.5 Voice control", "empty", 'Its whole text is "Not applicable.".'),
    ("2.5.2 Software reuse", "empty", 'Its whole text is "None.".'),
    ("2.6.2 Test equipment", "empty", 'Its whole text is "None.".'),
    ("2.7 RESERVED", "empty", 'Its whole text is "This section is intentionally left blank.".'),
    (
        "3 REQUIREMENT IDENTITIES",
        "left_out",
        "Back matter (pages 24-27): lists all 120 codes; it checks the Customer IDs.",
    ),
]


# Words the document itself prints in capitals in its text (HDMI, USB, TV, ...): an acronym keeps its capitals in a sentence-case title.
ACRONYMS = {
    w
    for sec in tv_twin.SECTIONS
    for r in sec.reqs
    for w in re.findall(r"\b[A-Z][A-Z0-9]{1,5}\b", r.text)
} | {"TV"}


def clean_heading(heading: str) -> str:
    text = re.sub(r"^\s*\d+(?:\.\d+)*\s+", "", heading)
    text = re.sub(r"\s*\([A-Z0-9_]+\)\s*$", "", text).strip()
    if not text.isupper():
        return text
    words = [w if w in ACRONYMS else w.lower() for w in text.split()]
    first = words[0] if words[0] in ACRONYMS else words[0][:1].upper() + words[0][1:]
    return " ".join([first, *words[1:]])


sections = [s for s in tv_twin.SECTIONS if s.number.startswith("2")]
holds = {s.number: bool(s.reqs) for s in sections}
kids = {
    s.number: [
        c.number for c in sections if c.number.rsplit(".", 1)[0] == s.number and "." in c.number
    ]
    for s in sections
}
kids["2"] = [c.number for c in sections if c.number.count(".") == 1]


def has_content(num: str) -> bool:
    return holds[num] or any(has_content(k) for k in kids[num])


nodes: list[dict] = []
ids: dict[str, str] = {}
n = 0
for s in sections:
    heading = f"{s.number} {s.title}"
    if s.kind == "empty" or not has_content(s.number):
        continue
    parent_num = s.number.rsplit(".", 1)[0] if "." in s.number else None
    decision, title, reason = DECISIONS.get(heading, ("keep", None, ""))
    if decision == "drop_wrapper":  # the level is removed: its children move up to its parent
        ids[s.number] = ids[parent_num]
        continue
    item_type = "Epic" if not holds[s.number] else "Feature"
    n += 1
    sid = f"S{n}"
    ids[s.number] = sid
    original = clean_heading(heading)
    desc = ""
    if s.number == "2":
        desc = EPIC_DESC
    nodes.append(
        {
            "id": sid,
            "type": item_type,
            "title": title if decision in ("spelling", "rename") else original,
            "original_title": original,
            "proposed_title": title if decision == "rename" else None,
            "customer_id": None,
            "description": desc,
            "source_section": heading,
            "decision": decision,
            "decision_reason": reason,
            "parent": ids.get(parent_num) if parent_num else None,
        }
    )
    last_req: dict[str, str] = {}
    for r in s.reqs:
        text = " ".join(r.text.replace("<br/>", "").replace("|", " ").split())
        statement = text
        if r.items:
            statement += "\n" + "\n".join(("- " + i) if r.marker else i for i in r.items)
        if r.note:
            statement += "\n" + r.note
        if r.full_note:
            statement += "\n" + r.full_note
        trace = ("Satisfies:\n" + "\n".join(r.parents)) if r.parents else ""
        n += 1
        rid = f"R{n}"
        parent = sid
        if r.code and "." in r.code:  # a coded sub-item: sub-Requirement of its parent requirement
            parent = last_req[r.code.rsplit(".", 1)[0]]
        elif r.code:
            last_req[r.code] = rid
        nodes.append(
            {
                "id": rid,
                "type": "Requirement",
                "title": TITLES[r.code or ""],
                "customer_id": r.code,
                "description": statement + (f"\n\n{trace}" if trace else ""),
                "source_section": heading,
                "decision": "keep",
                "parent": parent,
            }
        )

# --- derived marks and what the file states -------------------------------------------------------------------------------------
for x in nodes:
    marks = []
    if x["type"] == "Requirement":
        st = x["description"].split("\n\n")[0]
        if "TBD" in st:
            marks.append("TBD")
        if re.search(r"\bshould\b", st):
            marks.append("Should")
        if re.search(r"\bwill\b", st):
            marks.append("Will")
        if not re.search(r"\b(shall|should|will|must)\b", st):
            marks.append("No obligation")
    x["derived_marks"] = marks
    x["file_tags"] = []
    x["requirement_type"] = None
by_id = {x["id"]: x for x in nodes}


# --- self-checks --------------------------------------------------------------------------------------------------------------------
SPELLING: dict[str, str] = {}
STOP = set(
    "a an the of to in on at for and or by with its it be is are shall will should from as into than per up under over not does both when".split()
)


def stem(w: str) -> str:
    if w.endswith("ies") and len(w) > 4:
        return w[:-3] + "y"
    for suffix in ("ing", "es", "ed", "s"):
        if (
            len(w) > (4 if suffix == "ed" else 3)
            and w.endswith(suffix)
            and not (suffix == "s" and w.endswith("ss"))
        ):
            w = w[: -len(suffix)]
            break
    return w[:-1] if len(w) > 3 and w.endswith("e") else w


def stems(text: str) -> set[str]:
    return {stem(w) for w in re.findall(r"[a-z0-9]+(?:-[a-z0-9]+)*", text.lower())}


problems = []
reqs = [x for x in nodes if x["type"] == "Requirement"]
codes = [x["customer_id"] for x in reqs if x["customer_id"]]
if len(reqs) != 121 or len(codes) != 120 or len(set(codes)) != 120:
    problems.append(f"counts {len(reqs)} / {len(codes)}")
code_like = re.compile(r"\b[a-z]{3}_\d+(\.[a-z])?\b")
for x in nodes:
    if re.match(r"^\s*\d", x["title"]) or code_like.search(x["title"]):
        problems.append("title with number/code: " + x["title"])
    if x["type"] == "Requirement" and code_like.search(x["description"].split("\n\n")[0]):
        problems.append("description with code: " + x["title"])
for x in reqs:
    bad = sorted((stems(x["title"]) - STOP) - stems(x["description"]))
    if bad:
        problems.append(f"ungrounded {x['customer_id']}: {bad}")
roots = [x for x in nodes if not x["parent"]]
if any(r["type"] != "Epic" for r in roots):
    problems.append("a non-Epic root")
for x in nodes:
    p = by_id.get(x["parent"]) if x["parent"] else None
    if x["type"] == "Requirement" and p and p["type"] == "Epic":
        problems.append("Requirement under an Epic: " + x["title"])
    if x["type"] == "Epic" and p and p["type"] != "Epic":
        problems.append("Epic under a non-Epic: " + x["title"])

(HERE / "tv_gold_tree.json").write_text(
    json.dumps(
        {"nodes": nodes, "left_out": [dict(zip(("what", "decision", "why"), t)) for t in LEFT_OUT]},
        ensure_ascii=False,
        indent=1,
    ),
    encoding="utf-8",
)

print(Counter(x["type"] for x in nodes), "IDs", len(codes), "problems", len(problems))
for p in problems:
    print("  ", p)
if problems:
    raise SystemExit(1)
