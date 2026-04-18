import pandas as pd
import numpy as np
import re
import fitz
from sentence_transformers import SentenceTransformer
import faiss
from rank_bm25 import BM25Okapi
import groq
from datetime import datetime
import json
import os
from collections import defaultdict
from fastapi import FastAPI, HTTPException
from fastapi.middleware.cors import CORSMiddleware
from pydantic import BaseModel
from typing import List, Dict, Optional
import uvicorn
import time

# ============================================
# INITIALIZE FASTAPI
# ============================================
app = FastAPI(title="RAG System API - Ghana Elections & Budget")

# Add CORS for Lovable frontend
app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)

# ============================================
# GLOBAL VARIABLES (Will be populated on startup)
# ============================================
df = None
winners = {}
chunks = []
chunk_texts = []
model = None
index = None
bm25 = None
llm_client = None
system_ready = False

# ============================================
# LOAD DATA FUNCTION (Called on startup)
# ============================================
def load_data():
    global df, winners, chunks, chunk_texts, model, index, bm25, llm_client, system_ready
    
    print("="*60)
    print("🚀 LOADING RAG SYSTEM ON HUGGING FACE SPACES")
    print("="*60)
    
    # Check if data files exist
    if not os.path.exists("Ghana_Election_Result.csv"):
        print("❌ Error: Ghana_Election_Result.csv not found!")
        return False
    
    if not os.path.exists("2025-Budget-Statement-and-Economic-Policy_v4.pdf"):
        print("❌ Error: Budget PDF not found!")
        return False
    
    # Load election data
    df = pd.read_csv("Ghana_Election_Result.csv")
    
    # Fix column names
    df.columns = df.columns.str.replace('\xa0', ' ', regex=False)
    df.columns = df.columns.str.strip()
    
    # Find region column
    region_col = None
    for col in df.columns:
        if 'region' in col.lower():
            region_col = col
            break
    if region_col is None:
        region_col = df.columns[0]
    
    print(f"📊 Loaded {len(df)} election records")
    print(f"📍 Using '{region_col}' as region column")
    
    # Pre-compute winners
    for year in df['Year'].unique():
        year_data = df[df['Year'] == year]
        national = year_data.groupby(['Candidate', 'Party'])['Votes'].sum().reset_index()
        national = national.sort_values('Votes', ascending=False)
        winner = national.iloc[0]
        total = national['Votes'].sum()
        winners[int(year)] = {
            'winner': winner['Candidate'],
            'party': winner['Party'],
            'votes': int(winner['Votes']),
            'percent': round(winner['Votes']/total*100, 1),
            'total': int(total)
        }
    
    print(f"🏆 Pre-computed winners for: {list(winners.keys())}")
    
    # Load and extract budget PDF
    print("\n📄 Loading budget PDF...")
    doc = fitz.open("2025-Budget-Statement-and-Economic-Policy_v4.pdf")
    
    full_budget_text = ""
    for page_num in range(len(doc)):
        page = doc[page_num]
        text = page.get_text()
        full_budget_text += f"\n--- PAGE {page_num + 1} ---\n"
        full_budget_text += text
    
    doc.close()
    print(f"✅ Extracted {len(full_budget_text):,} characters")
    
    # Create chunks
    print("\n🔄 Creating chunks...")
    chunks = []
    chunk_texts = []
    
    # Election chunks (national winners)
    for year, info in winners.items():
        text = f"""
    GHANA PRESIDENTIAL ELECTION {year}
    WINNER: {info['winner']} ({info['party']})
    VOTES: {info['votes']:,}
    PERCENTAGE: {info['percent']}%
    TOTAL VALID VOTES: {info['total']:,}
    """
        chunks.append({
            'text': text,
            'source': 'election',
            'year': year,
            'type': 'national',
            'id': f'election_national_{year}'
        })
        chunk_texts.append(text)
    
    # Regional chunks
    try:
        for (year, region), group in df.groupby(['Year', region_col]):
            winner_row = group.loc[group['Votes'].idxmax()]
            text = f"""
    GHANA ELECTION {year} - {region} REGION
    WINNER: {winner_row['Candidate']} ({winner_row['Party']})
    VOTES: {winner_row['Votes']:,}
    """
            for _, row in group.iterrows():
                text += f"\n{row['Candidate']} ({row['Party']}): {row['Votes']:,} votes"
            chunks.append({
                'text': text,
                'source': 'election',
                'year': int(year),
                'region': str(region),
                'type': 'regional',
                'id': f'election_regional_{year}_{str(region).replace(" ", "_")}'
            })
            chunk_texts.append(text)
    except Exception as e:
        print(f"⚠️ Regional chunks limited: {e}")
    
    # Budget chunks
    pages = re.split(r'--- PAGE \d+ ---', full_budget_text)
    budget_chunk_count = 0
    
    for i, page_text in enumerate(pages):
        if len(page_text.strip()) < 200:
            continue
        
        text_lower = page_text.lower()
        if 'education' in text_lower or 'school' in text_lower:
            category = 'Education'
        elif 'health' in text_lower or 'hospital' in text_lower:
            category = 'Health'
        elif 'gdp' in text_lower or 'economy' in text_lower:
            category = 'Economy'
        else:
            category = 'General'
        
        chunks.append({
            'text': page_text.strip(),
            'source': 'budget',
            'category': category,
            'page': i + 1,
            'id': f'budget_page_{i+1}'
        })
        chunk_texts.append(page_text.strip())
        budget_chunk_count += 1
    
    print(f"📦 Created {len(chunks)} total chunks")
    
    # Build embeddings
    print("\n🔄 Building embeddings...")
    model = SentenceTransformer('all-MiniLM-L6-v2')
    embeddings = model.encode(chunk_texts, normalize_embeddings=True, show_progress_bar=True)
    dimension = embeddings.shape[1]
    
    # FAISS index
    index = faiss.IndexFlatIP(dimension)
    index.add(embeddings.astype(np.float32))
    
    # BM25 index
    tokenized_chunks = [re.findall(r'\b[a-z]{3,}\b', t.lower()) for t in chunk_texts]
    bm25 = BM25Okapi(tokenized_chunks)
    
    print(f"✅ Embeddings ready. FAISS has {index.ntotal} vectors")
    
    # Groq setup
    GROQ_API_KEY = os.environ.get("GROQ_API_KEY")
    if not GROQ_API_KEY:
        print("⚠️ GROQ_API_KEY not set! Please add it in Space Settings → Secrets")
        return False
    
    try:
        llm_client = groq.Client(api_key=GROQ_API_KEY)
        print("✅ Groq API initialized")
    except Exception as e:
        print(f"❌ Error initializing Groq: {e}")
        return False
    
    system_ready = True
    
    print("\n" + "="*60)
    print("✅ RAG SYSTEM FULLY LOADED AND READY!")
    print("="*60)
    return True

# ============================================
# SEARCH FUNCTION
# ============================================
def search(query, k=5):
    if model is None or index is None:
        return []
    
    q_emb = model.encode([query], normalize_embeddings=True)
    scores, indices = index.search(q_emb.astype(np.float32), k*2)
    
    tokenized_q = re.findall(r'\b[a-z]{3,}\b', query.lower())
    bm25_scores = bm25.get_scores(tokenized_q)
    bm25_indices = np.argsort(bm25_scores)[-k*2:][::-1]
    
    results = {}
    for rank, (score, idx) in enumerate(zip(scores[0], indices[0])):
        if idx != -1 and score > 0.25:
            rrf_score = 1 / (rank + 61)
            results[idx] = {
                'chunk': chunks[idx],
                'dense_score': float(score),
                'final_score': rrf_score
            }
    
    for rank, idx in enumerate(bm25_indices):
        if bm25_scores[idx] > 0:
            rrf_score = 1 / (rank + 61)
            if idx in results:
                results[idx]['final_score'] += rrf_score
            else:
                results[idx] = {
                    'chunk': chunks[idx],
                    'dense_score': 0,
                    'final_score': rrf_score
                }
    
    sorted_results = sorted(results.values(), key=lambda x: x['final_score'], reverse=True)[:k]
    return sorted_results

# ============================================
# RAG FUNCTION
# ============================================
def ask_rag(question):
    # Fast path for direct election winners
    year_match = re.search(r'(\d{4})', question)
    if year_match and ('won' in question.lower() or 'winner' in question.lower() or 'who' in question.lower()):
        year = int(year_match.group(1))
        if year in winners:
            info = winners[year]
            return f"In {year}, **{info['winner']}** of the **{info['party']}** won with **{info['votes']:,}** votes ({info['percent']}% of total)."
    
    retrieved = search(question, k=5)
    
    if not retrieved:
        return "I couldn't find relevant information in the documents."
    
    context_parts = []
    for i, r in enumerate(retrieved, 1):
        chunk = r['chunk']
        source = chunk['source'].upper()
        if source == 'BUDGET' and 'category' in chunk:
            source += f" ({chunk['category']})"
        context_parts.append(f"[{i}] {source}:\n{chunk['text'][:1500]}")
    
    context = "\n\n---\n\n".join(context_parts)
    
    prompt = f"""You are a helpful AI assistant. Answer based ONLY on the context below.

CONTEXT:
{context}

QUESTION: {question}

INSTRUCTIONS:
1. Use specific numbers and names when available
2. If not in context, say "Based on the documents provided, I cannot find that information."

ANSWER:"""
    
    try:
        response = llm_client.chat.completions.create(
            model="llama-3.3-70b-versatile",
            messages=[{"role": "user", "content": prompt}],
            temperature=0.1,
            max_tokens=800
        )
        return response.choices[0].message.content
    except Exception as e:
        return f"Error generating response: {str(e)}"

# ============================================
# API ENDPOINTS
# ============================================
class QueryRequest(BaseModel):
    question: str

class QueryResponse(BaseModel):
    question: str
    answer: str
    timestamp: str

@app.on_event("startup")
async def startup_event():
    """Load data when the API starts"""
    success = load_data()
    if not success:
        print("❌ Failed to load data!")

@app.get("/")
def root():
    return {"message": "RAG System API - Ghana Elections & Budget", "status": "running"}

@app.get("/health")
def health():
    if not system_ready:
        return {"status": "loading", "message": "System is still initializing..."}
    return {"status": "healthy", "chunks_loaded": len(chunks) if chunks else 0, "winners_loaded": len(winners)}

@app.post("/query", response_model=QueryResponse)
def query(request: QueryRequest):
    if not system_ready:
        raise HTTPException(status_code=503, detail="System is still loading. Please try again in a moment.")
    
    try:
        answer = ask_rag(request.question)
        return QueryResponse(
            question=request.question,
            answer=answer,
            timestamp=datetime.now().isoformat()
        )
    except Exception as e:
        raise HTTPException(status_code=500, detail=str(e))