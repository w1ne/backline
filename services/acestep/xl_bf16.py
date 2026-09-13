import os, json, shutil, torch
from huggingface_hub import hf_hub_download
from safetensors.torch import load_file, save_file
REPO="ACE-Step/acestep-v15-xl-turbo"; DST="/opt/ace-step/checkpoints/acestep-v15-xl-turbo"; TMP="/dev/shm/xl"
os.makedirs(DST, exist_ok=True); os.makedirs(TMP, exist_ok=True)
for f in ["config.json","configuration_acestep_v15.py","modeling_acestep_v15_xl_turbo.py","silence_latent.pt","model.safetensors.index.json","README.md"]:
    p=hf_hub_download(REPO, f, local_dir=TMP); shutil.copy(p, os.path.join(DST,f))
for i in range(1,5):
    name=f"model-0000{i}-of-00004.safetensors"
    if os.path.exists(os.path.join(DST,name)): print("skip",name,flush=True); continue
    print("download",name,flush=True)
    p=hf_hub_download(REPO, name, local_dir=TMP)
    sd=load_file(p)
    out={k:(v.to(torch.bfloat16) if v.dtype==torch.float32 else v) for k,v in sd.items()}
    save_file(out, os.path.join(DST,name), metadata={"format":"pt"})
    del sd,out; os.remove(p); shutil.rmtree(os.path.join(TMP,".cache"),ignore_errors=True)
    print("done",name,flush=True); os.system(f"df -h / | tail -1; du -sh {DST}")
print("ALL DONE",flush=True)
