import importlib
import json
import pathlib
from google.protobuf import descriptor_pb2
from hoymiles_wifi.dtu import DTU
from hoymiles_wifi.protobuf import RealDataNew_pb2

root = pathlib.Path(__file__).resolve().parents[1]
protocol = root / "protocol"
protocol.mkdir(exist_ok=True)
descriptors = descriptor_pb2.FileDescriptorSet()
names = ["APPInfomationData", "RealDataNew", "GetConfig", "NetworkInfo", "AppGetHistPower", "InfomationData", "CommandPB", "APPHeartbeatPB"]
seen = set()


def add(descriptor):
    if descriptor.name in seen:
        return
    for dependency in descriptor.dependencies:
        add(dependency)
    seen.add(descriptor.name)
    descriptor.CopyToProto(descriptors.file.add())


for name in names:
    add(importlib.import_module("hoymiles_wifi.protobuf." + name + "_pb2").DESCRIPTOR)
(protocol / "hoymiles.desc").write_bytes(descriptors.SerializeToString())
fixtures = []
for encrypted in (False, True):
    dtu = DTU("127.0.0.1", is_encrypted=encrypted, enc_rand=bytes(range(16)))
    message = RealDataNew_pb2.RealDataNewResDTO()
    message.time_ymd_hms = b"2026-11-07 12:00:00"
    message.offset = 28800
    message.time = 1794049200
    message.cp = 0
    frame = dtu.generate_message(bytes.fromhex("a311"), message, False, 0, 0)
    fixtures.append({"encrypted": encrypted, "frame": frame.hex(), "time": message.time, "text": message.time_ymd_hms.decode(), "sequence": 1})
(root / "test" / "reference-frames.json").write_text(json.dumps(fixtures, indent=2) + "\n", encoding="utf-8")
print(json.dumps({"files": sorted(seen), "bytes": len(descriptors.SerializeToString()), "referenceFrames": len(fixtures)}))
