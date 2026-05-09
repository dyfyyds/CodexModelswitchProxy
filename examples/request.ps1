$body = @{
  model = "deepseek-coder"
  input = "用一句话介绍这个代理。"
} | ConvertTo-Json

Invoke-RestMethod `
  -Method Post `
  -Uri "http://127.0.0.1:8080/v1/responses" `
  -ContentType "application/json" `
  -Body $body
