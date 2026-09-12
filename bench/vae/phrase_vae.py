"""
Minimal symbolic-music VAE for a more experimental companion voice.

bench/amt is an autoregressive transformer: token-by-token generation, which
is why most of that bench is spent hiding inference latency behind a
lookahead/commit buffer. This is the opposite kind of model -- a small VAE
that maps a short melodic phrase to a latent point and back in a single
forward pass. Decoding is near-instant, so there's no scheduling problem to
solve, but it's also a much cruder model: fixed-length phrases, pitch only
(no rhythm), trained from scratch on a few thousand synthetic phrases in a
couple of seconds on GPU (~20s on CPU at the default settings), and prone
to the usual small-VAE failure modes (blurry or
repetitive output, posterior collapse if undertrained).

Phrases are represented as scale-degree sequences (0-7, one octave), not
absolute MIDI pitch, so the model is automatically key-agnostic: the same
checkpoint works in whatever key the live melody happens to be in.
"""

import random

import torch
import torch.nn as nn
import torch.nn.functional as F

N_DEGREES = 8
PHRASE_LEN = 8
LATENT_DIM = 8
HIDDEN = 64


class PhraseVAE(nn.Module):
    def __init__(self, n_degrees=N_DEGREES, phrase_len=PHRASE_LEN, latent_dim=LATENT_DIM, hidden=HIDDEN):
        super().__init__()
        self.phrase_len = phrase_len
        self.n_degrees = n_degrees
        self.enc_embed = nn.Embedding(n_degrees, hidden)
        self.enc_rnn = nn.GRU(hidden, hidden, batch_first=True)
        self.to_mu = nn.Linear(hidden, latent_dim)
        self.to_logvar = nn.Linear(hidden, latent_dim)
        self.dec_init = nn.Linear(latent_dim, hidden)
        self.dec_embed = nn.Embedding(n_degrees + 1, hidden)  # +1 for the start token
        self.dec_cell = nn.GRUCell(hidden, hidden)
        self.dec_out = nn.Linear(hidden, n_degrees)

    def encode(self, degrees):
        x = self.enc_embed(degrees)
        _, h = self.enc_rnn(x)
        return self.to_mu(h.squeeze(0)), self.to_logvar(h.squeeze(0))

    def reparameterize(self, mu, logvar, temperature=1.0):
        std = torch.exp(0.5 * logvar) * temperature
        return mu + torch.randn_like(std) * std

    def decode(self, z, target=None, sample=False):
        """target given (training): teacher-forced logits. Otherwise: (logits, sampled tokens)."""
        b = z.size(0)
        h = torch.tanh(self.dec_init(z))
        input_tok = torch.full((b,), self.n_degrees, dtype=torch.long, device=z.device)  # start token
        logits_seq, out_toks = [], []
        for t in range(self.phrase_len):
            h = self.dec_cell(self.dec_embed(input_tok), h)
            logits = self.dec_out(h)
            logits_seq.append(logits)
            if target is not None:
                input_tok = target[:, t]
            else:
                probs = F.softmax(logits, dim=-1)
                input_tok = torch.multinomial(probs, 1).squeeze(1) if sample else logits.argmax(dim=-1)
                out_toks.append(input_tok)
        logits_seq = torch.stack(logits_seq, dim=1)
        if target is not None:
            return logits_seq
        return logits_seq, torch.stack(out_toks, dim=1)

    def forward(self, degrees):
        mu, logvar = self.encode(degrees)
        z = self.reparameterize(mu, logvar)
        return self.decode(z, target=degrees), mu, logvar


def random_phrase(rng, phrase_len=PHRASE_LEN, n_degrees=N_DEGREES):
    """Same random-walk-with-cadence shape as bench/amt/melody.py, in scale
    degrees instead of MIDI pitch, and duplicated here (not imported) so
    this bench stays self-contained, matching the other bench/ kits."""
    steps = [-2, -1, -1, 0, 1, 1, 1, 2]
    degree = rng.randrange(n_degrees)
    seq = []
    for i in range(phrase_len):
        degree = 0 if i % 8 == 7 else max(0, min(n_degrees - 1, degree + rng.choice(steps)))
        seq.append(degree)
    return seq


def train(seed=0, n_examples=4000, epochs=60, batch_size=64, beta=0.5, lr=1e-3, quiet=False):
    rng = random.Random(seed)
    torch.manual_seed(seed)

    data = torch.tensor([random_phrase(rng) for _ in range(n_examples)], dtype=torch.long)
    model = PhraseVAE()
    opt = torch.optim.Adam(model.parameters(), lr=lr)

    for epoch in range(epochs):
        perm = torch.randperm(n_examples)
        total_recon, total_kl, total_acc = 0.0, 0.0, 0.0
        for i in range(0, n_examples, batch_size):
            batch = data[perm[i:i + batch_size]]
            logits, mu, logvar = model(batch)
            recon = F.cross_entropy(logits.reshape(-1, N_DEGREES), batch.reshape(-1))
            kl = -0.5 * torch.mean(1 + logvar - mu.pow(2) - logvar.exp())
            loss = recon + beta * kl
            opt.zero_grad()
            loss.backward()
            opt.step()
            total_recon += recon.item() * batch.size(0)
            total_kl += kl.item() * batch.size(0)
            total_acc += (logits.argmax(-1) == batch).float().mean().item() * batch.size(0)
        if not quiet and (epoch % 50 == 0 or epoch == epochs - 1):
            print(f"epoch {epoch:4d}  recon={total_recon/n_examples:.3f}  "
                  f"kl={total_kl/n_examples:.3f}  token_acc={total_acc/n_examples:.3f}")

    return model


if __name__ == "__main__":
    train()
